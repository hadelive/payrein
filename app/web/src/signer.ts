// How the owner signs. Mainnet: their wallet, which shows the call's arguments (T20). Devnet: the
// sandbox owner key, because no wallet can reach a local sandbox; refused on any other RPC.

import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { actionCreators } from "@near-js/transactions";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { cfg } from "./chain";

export interface CallResult {
  /** Missing when a redirect wallet left the page; the hash comes back on the return URL. */
  txHash?: string;
  error?: string;
}

export interface OwnerSigner {
  readonly kind: "wallet" | "devnet key";
  accountId(): string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Calls an owner method on the vault with 1 yoctoNEAR attached. */
  call(method: string, args: object): Promise<CallResult>;
  onChange(cb: () => void): void;
}

const GAS = "100000000000000"; // 100 Tgas
const PENDING_KEY = "vault.pendingCall";

export function vaultError(text: string): string {
  return /Smart contract panicked: (\w+)/.exec(text)?.[1] ?? /"(\w+)"\s*\}?\s*\}?$/.exec(text)?.[1] ?? text;
}

class WalletSigner implements OwnerSigner {
  readonly kind = "wallet" as const;
  private selector?: WalletSelector;
  private modal?: WalletSelectorModal;
  private account: string | null = null;
  private listeners: Array<() => void> = [];

  async init(): Promise<void> {
    this.selector = await setupWalletSelector({
      network: "mainnet",
      modules: [setupMyNearWallet(), setupIntearWallet()],
    });
    this.modal = setupModal(this.selector, { contractId: cfg.vaultId });
    const sync = () => {
      this.account = this.selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
      this.listeners.forEach((l) => l());
    };
    this.selector.store.observable.subscribe(sync);
    sync();
  }

  accountId(): string | null {
    return this.account;
  }

  async signIn(): Promise<void> {
    this.modal?.show();
  }

  async signOut(): Promise<void> {
    if (this.selector?.isSignedIn()) await (await this.selector.wallet()).signOut();
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  async call(method: string, args: object): Promise<CallResult> {
    if (!this.selector) return { error: "wallet not ready" };
    const wallet = await this.selector.wallet();
    // A redirect wallet leaves the page; remember what we asked for so the return URL can finish it.
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ method, args }));
    try {
      const out = await wallet.signAndSendTransaction({
        receiverId: cfg.vaultId,
        actions: [actionCreators.functionCall(method, args, BigInt(GAS), 1n)],
      });
      sessionStorage.removeItem(PENDING_KEY);
      if (!out) return {};
      const failure = (out.status as { Failure?: unknown }).Failure;
      return failure ? { txHash: out.transaction.hash, error: vaultError(JSON.stringify(failure)) } : { txHash: out.transaction.hash };
    } catch (e) {
      sessionStorage.removeItem(PENDING_KEY);
      return { error: vaultError(String((e as Error).message ?? e)) };
    }
  }
}

class DevKeySigner implements OwnerSigner {
  readonly kind = "devnet key" as const;
  private account: Account;

  constructor(
    private ownerId: string,
    key: KeyPairString,
  ) {
    const host = new URL(cfg.rpcUrl).hostname;
    if (cfg.network !== "devnet" || !["127.0.0.1", "localhost"].includes(host)) {
      throw new Error("the devnet key signer only runs against a local sandbox");
    }
    this.account = new Account(ownerId, new JsonRpcProvider({ url: cfg.rpcUrl }), KeyPairSigner.fromSecretKey(key));
  }

  accountId(): string {
    return this.ownerId;
  }
  async signIn(): Promise<void> {}
  async signOut(): Promise<void> {}
  onChange(): void {}

  async call(method: string, args: object): Promise<CallResult> {
    try {
      const r = await this.account.callFunctionRaw({
        contractId: cfg.vaultId,
        methodName: method,
        args: args as Record<string, unknown>,
        deposit: 1n,
        gas: BigInt(GAS),
        waitUntil: "FINAL",
      });
      const failure = (r.status as { Failure?: unknown }).Failure;
      return failure ? { txHash: r.transaction.hash, error: vaultError(JSON.stringify(failure)) } : { txHash: r.transaction.hash };
    } catch (e) {
      return { error: vaultError(String((e as Error).message ?? e)) };
    }
  }
}

export async function createSigner(): Promise<OwnerSigner> {
  if (cfg.network === "devnet") {
    const owner = import.meta.env.VITE_DEV_OWNER_ID as string | undefined;
    const key = import.meta.env.VITE_DEV_OWNER_KEY as KeyPairString | undefined;
    if (!owner || !key) throw new Error("devnet needs VITE_DEV_OWNER_ID and VITE_DEV_OWNER_KEY");
    return new DevKeySigner(owner, key);
  }
  const s = new WalletSigner();
  await s.init();
  return s;
}

/** After a redirect wallet returns: the call that was pending and its transaction hash, once. */
export function takeRedirectResult(): { method: string; args: object; txHash?: string; error?: string } | null {
  const pending = sessionStorage.getItem(PENDING_KEY);
  if (!pending) return null;
  const params = new URLSearchParams(window.location.search);
  const txHash = params.get("transactionHashes")?.split(",").at(-1);
  const error = params.get("errorCode") ?? undefined;
  if (!txHash && !error) return null;
  sessionStorage.removeItem(PENDING_KEY);
  window.history.replaceState({}, "", window.location.pathname);
  return { ...(JSON.parse(pending) as { method: string; args: object }), txHash, error };
}
