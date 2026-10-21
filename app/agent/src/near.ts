// The agent's only NEAR authority: function-call keys that may call `vault.request_payment`.
// Large integers stay strings end to end (T25).

import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";

export interface PaymentRequest {
  merchant_id: string;
  token_id: string;
  amount: string;
  invoice_ref: string;
  expires_at_ns: string;
  policy_version: number;
}

export interface PaymentOp extends PaymentRequest {
  op_id: string;
}

export interface VaultConfig {
  owner: string;
  agent: string;
  intents: string;
  policy: { version: number; token_id: string; max_ttl_sec: number; approval_threshold: string };
  next_op_id: string;
}

export type CallOutcome =
  | { ok: true; op: PaymentOp; txHash: string }
  | { ok: false; error: string; txHash?: string };

export class VaultClient {
  readonly provider: JsonRpcProvider;
  private accounts: Account[];

  constructor(
    rpcUrl: string,
    readonly vaultId: string,
    readonly agentId: string,
    /** One key per parallel request; nonces are per key (T5). */
    keys: KeyPairString[],
  ) {
    if (keys.length === 0) throw new Error("at least one agent key is required");
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.accounts = keys.map((k) => new Account(agentId, this.provider, KeyPairSigner.fromSecretKey(k)));
  }

  get keyCount(): number {
    return this.accounts.length;
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.vaultId, method, args })) as T;
  }

  config(): Promise<VaultConfig> {
    return this.view<VaultConfig>("get_config");
  }

  /** Sends `request_payment` with key `key`. A vault refusal is returned, not thrown. */
  async requestPayment(req: PaymentRequest, key = 0): Promise<CallOutcome> {
    const account = this.accounts[key % this.accounts.length]!;
    try {
      const res = await account.callFunctionRaw({
        contractId: this.vaultId,
        methodName: "request_payment",
        args: { req },
        gas: 100_000_000_000_000n,
        waitUntil: "FINAL",
      });
      const txHash = res.transaction.hash;
      const status = res.status as { SuccessValue?: string; Failure?: unknown };
      if (typeof status === "object" && status.SuccessValue !== undefined) {
        const op = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as PaymentOp;
        return { ok: true, op, txHash };
      }
      return { ok: false, error: vaultError(JSON.stringify(status)), txHash };
    } catch (e) {
      return { ok: false, error: vaultError(String((e as Error).message ?? e)) };
    }
  }
}

const CODES = [
  "Paused", "NotAgent", "InsufficientGas", "PolicyVersionMismatch", "Expired", "TtlTooLong",
  "MerchantNotAllowed", "WrongToken", "ZeroAmount", "InvoiceRefTooLong", "OverPerPayment",
  "TooManyPending", "OverDaily",
];

/** The vault's error code if the text carries one, else the text itself. */
export function vaultError(text: string): string {
  return CODES.find((c) => text.includes(`"${c}"`) || text.includes(`Smart contract panicked: ${c}`) || text.includes(c)) ?? text;
}
