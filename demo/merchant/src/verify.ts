// Checks that a transaction paid an invoice (docs/payment-spec.md, "Merchant side"; threat T24).
// Pure: the server fetches the transaction, this decides.

export interface Invoice {
  invoiceRef: string;
  merchantId: string;
  tokenId: string;
  /** Base units, decimal string. */
  amount: string;
  expiresAtNs: string;
}

export interface VerifyConfig {
  /** The Intents contract whose receipts are trusted, e.g. intents.near. */
  intentsId: string;
  merchantId: string;
  /** When set, only payments from this vault count. */
  vaultId?: string;
}

/** The subset of an RPC `tx` result this needs. */
export interface TxResult {
  final_execution_status?: string;
  receipts_outcome: Array<{
    id: string;
    outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
  }>;
}

export type Verdict =
  | { ok: true; receiptId: string; opId: string }
  | { ok: false; reason: string };

interface MtTransfer {
  old_owner_id?: unknown;
  new_owner_id?: unknown;
  token_ids?: unknown;
  amounts?: unknown;
  memo?: unknown;
}

function transfers(log: string): MtTransfer[] {
  if (!log.startsWith("EVENT_JSON:")) return [];
  try {
    const ev = JSON.parse(log.slice("EVENT_JSON:".length));
    if (ev?.standard !== "nep245" || ev?.event !== "mt_transfer" || !Array.isArray(ev.data)) return [];
    return ev.data;
  } catch {
    return [];
  }
}

function succeeded(status: Record<string, unknown>): boolean {
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

const MEMO = /^vault:(\d+):(.+)$/;

export function verifyPayment(tx: TxResult, invoice: Invoice, cfg: VerifyConfig): Verdict {
  if (tx.final_execution_status !== "FINAL") return { ok: false, reason: "transaction is not final" };
  if (invoice.merchantId !== cfg.merchantId) return { ok: false, reason: "invoice is for another merchant" };

  for (const r of tx.receipts_outcome) {
    // Anyone can log an identical event from their own contract; only Intents' receipts move funds.
    if (r.outcome.executor_id !== cfg.intentsId || !succeeded(r.outcome.status)) continue;
    for (const log of r.outcome.logs) {
      for (const t of transfers(log)) {
        const memo = typeof t.memo === "string" ? MEMO.exec(t.memo) : null;
        const matches =
          t.new_owner_id === cfg.merchantId &&
          (cfg.vaultId === undefined || t.old_owner_id === cfg.vaultId) &&
          Array.isArray(t.token_ids) && t.token_ids.length === 1 && t.token_ids[0] === invoice.tokenId &&
          Array.isArray(t.amounts) && t.amounts.length === 1 && t.amounts[0] === invoice.amount &&
          memo !== null && memo[2] === invoice.invoiceRef;
        if (matches && memo) return { ok: true, receiptId: r.id, opId: memo[1]! };
      }
    }
  }
  return { ok: false, reason: "no successful Intents transfer matches the invoice" };
}
