// Local devnet only: no wallet can reach a sandbox, so the owner's sandbox key signs. Loaded only by
// a dev build, and only after the RPC proves to be the exact sandbox the launcher started (its
// genesis hash); a loopback URL alone could be a proxy to mainnet.

import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { cfg, genesisHash } from "./chain";
import { GAS, vaultError, type CallResult, type OwnerSigner } from "./signer";

class DevKeySigner implements OwnerSigner {
  readonly kind = "devnet key" as const;
  private account: Account;

  constructor(
    private ownerId: string,
    key: KeyPairString,
  ) {
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

export async function createDevSigner(): Promise<OwnerSigner> {
  const owner = import.meta.env.VITE_DEV_OWNER_ID as string | undefined;
  const key = import.meta.env.VITE_DEV_OWNER_KEY as KeyPairString | undefined;
  const expected = import.meta.env.VITE_DEV_GENESIS as string | undefined;
  if (!owner || !key || !expected) throw new Error("devnet needs VITE_DEV_OWNER_ID, VITE_DEV_OWNER_KEY and VITE_DEV_GENESIS");
  const actual = await genesisHash();
  if (actual !== expected) throw new Error(`refusing to sign: RPC genesis ${actual} is not the local sandbox ${expected}`);
  return new DevKeySigner(owner, key);
}
