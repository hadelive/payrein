// T24: the merchant delivers only for a final, successful Intents transfer that matches the
// invoice exactly, and only once. The transaction shape is the sandbox spike's real output.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvoiceStore } from "../src/store.js";
import { verifyPayment, type Invoice, type TxResult } from "../src/verify.js";

const cfg = { intentsId: "intents.near", merchantId: "shop.near", vaultId: "vault.owner.near" };
const invoice: Invoice = {
  invoiceRef: "INV-1a2b3c4d",
  merchantId: "shop.near",
  tokenId: "nep141:wrap.near",
  amount: "2000000000000000000000",
  expiresAtNs: "1792575659823902000",
};

function transferLog(over: Record<string, unknown> = {}): string {
  const data = {
    old_owner_id: "vault.owner.near",
    new_owner_id: "shop.near",
    token_ids: ["nep141:wrap.near"],
    amounts: ["2000000000000000000000"],
    memo: "vault:7:INV-1a2b3c4d",
    ...over,
  };
  return `EVENT_JSON:${JSON.stringify({ standard: "nep245", version: "1.0.0", event: "mt_transfer", data: [data] })}`;
}

function tx(opts: { executor?: string; status?: Record<string, unknown>; log?: string; final?: string } = {}): TxResult {
  return {
    final_execution_status: opts.final ?? "FINAL",
    receipts_outcome: [
      { id: "r-vault", outcome: { executor_id: "vault.owner.near", logs: [], status: { SuccessReceiptId: "r-intents" } } },
      {
        id: "r-intents",
        outcome: {
          executor_id: opts.executor ?? "intents.near",
          logs: [opts.log ?? transferLog()],
          status: opts.status ?? { SuccessValue: "" },
        },
      },
    ],
  };
}

describe("verifyPayment", () => {
  it("accepts the matching transfer and returns its receipt and op", () => {
    expect(verifyPayment(tx(), invoice, cfg)).toEqual({ ok: true, receiptId: "r-intents", opId: "7" });
  });

  const rejected: Array<[string, TxResult]> = [
    ["an identical event logged by another contract", tx({ executor: "attacker.near" })],
    ["a failed receipt", tx({ status: { Failure: { ActionError: {} } } })],
    ["a transaction that is not final", tx({ final: "EXECUTED_OPTIMISTIC" })],
    ["another amount", tx({ log: transferLog({ amounts: ["1"] }) })],
    ["another token", tx({ log: transferLog({ token_ids: ["nep141:usdc.near"] }) })],
    ["another recipient", tx({ log: transferLog({ new_owner_id: "attacker.near" }) })],
    ["another payer", tx({ log: transferLog({ old_owner_id: "someone.near" }) })],
    ["another invoice in the memo", tx({ log: transferLog({ memo: "vault:7:INV-ffffffff" }) })],
    ["a memo with extra text", tx({ log: transferLog({ memo: "vault:7:INV-1a2b3c4d-x" }) })],
    ["a batch hiding the amount", tx({ log: transferLog({ token_ids: ["nep141:wrap.near", "x"], amounts: ["2000000000000000000000", "1"] }) })],
    ["a log that is not an event", tx({ log: "EVENT_JSON:{not json" })],
  ];
  it.each(rejected)("rejects %s", (_, t) => {
    expect(verifyPayment(t, invoice, cfg).ok).toBe(false);
  });

  it("rejects an invoice issued for another merchant", () => {
    expect(verifyPayment(tx(), { ...invoice, merchantId: "other.near" }, cfg).ok).toBe(false);
  });
});

describe("InvoiceStore.consume", () => {
  const fresh = () => {
    const s = new InvoiceStore(join(mkdtempSync(join(tmpdir(), "merchant-")), "db.sqlite"));
    s.create(invoice, "near-weekly", "tok-1");
    s.create({ ...invoice, invoiceRef: "INV-2" }, "near-weekly", "tok-2");
    return s;
  };

  it("pays an invoice once", () => {
    const s = fresh();
    expect(s.consume(invoice.invoiceRef, "tok-1", "r1", "tx1")).toBe("ok");
    expect(s.consume(invoice.invoiceRef, "tok-1", "r2", "tx2")).toBe("already_paid");
    expect(s.get(invoice.invoiceRef)?.paid).toBe(true);
  });

  it("uses one payment receipt for one invoice", () => {
    const s = fresh();
    expect(s.consume(invoice.invoiceRef, "tok-1", "r1", "tx1")).toBe("ok");
    expect(s.consume("INV-2", "tok-2", "r1", "tx1")).toBe("receipt_used");
    expect(s.get("INV-2")?.paid).toBe(false);
  });

  it("serves concurrent deliveries once", async () => {
    const s = fresh();
    const results = await Promise.all([1, 2, 3].map(async () => s.consume(invoice.invoiceRef, "tok-1", "r1", "tx1")));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("refuses unknown invoices", () => {
    expect(fresh().consume("INV-none", "tok-1", "r1", "tx1")).toBe("unknown_invoice");
  });

  it("refuses an observer who saw the payment but has no delivery token", () => {
    const s = fresh();
    expect(s.consume(invoice.invoiceRef, "guessed", "r1", "tx1")).toBe("wrong_delivery_token");
    expect(s.consume(invoice.invoiceRef, "tok-2", "r1", "tx1")).toBe("wrong_delivery_token");
    expect(s.get(invoice.invoiceRef)?.paid).toBe(false);
    expect(s.consume(invoice.invoiceRef, "tok-1", "r1", "tx1")).toBe("ok");
  });
});
