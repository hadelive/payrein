import { DatabaseSync } from "node:sqlite";
import type { Invoice } from "./verify.js";

export type ConsumeResult = "ok" | "unknown_invoice" | "already_paid" | "receipt_used";

/** Invoices and the payment receipts already used, so one payment serves one invoice once. */
export class InvoiceStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        invoice_ref TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        expires_at_ns TEXT NOT NULL,
        sku TEXT NOT NULL,
        paid_receipt TEXT,
        paid_tx TEXT
      );
      CREATE TABLE IF NOT EXISTS used_receipts (receipt_id TEXT PRIMARY KEY);
    `);
  }

  create(invoice: Invoice, sku: string): void {
    this.db
      .prepare(
        "INSERT INTO invoices (invoice_ref, merchant_id, token_id, amount, expires_at_ns, sku) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(invoice.invoiceRef, invoice.merchantId, invoice.tokenId, invoice.amount, invoice.expiresAtNs, sku);
  }

  get(invoiceRef: string): (Invoice & { sku: string; paid: boolean }) | undefined {
    const row = this.db.prepare("SELECT * FROM invoices WHERE invoice_ref = ?").get(invoiceRef) as
      | Record<string, string | null>
      | undefined;
    if (!row) return undefined;
    return {
      invoiceRef: row.invoice_ref!,
      merchantId: row.merchant_id!,
      tokenId: row.token_id!,
      amount: row.amount!,
      expiresAtNs: row.expires_at_ns!,
      sku: row.sku!,
      paid: row.paid_receipt !== null,
    };
  }

  /** Marks the invoice paid by `receiptId`, atomically: fails if either was already used. */
  consume(invoiceRef: string, receiptId: string, txHash: string): ConsumeResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT paid_receipt FROM invoices WHERE invoice_ref = ?").get(invoiceRef) as
        | { paid_receipt: string | null }
        | undefined;
      if (!row) return this.rollback("unknown_invoice");
      if (row.paid_receipt !== null) return this.rollback("already_paid");
      const used = this.db.prepare("SELECT 1 FROM used_receipts WHERE receipt_id = ?").get(receiptId);
      if (used) return this.rollback("receipt_used");
      this.db.prepare("INSERT INTO used_receipts (receipt_id) VALUES (?)").run(receiptId);
      this.db
        .prepare("UPDATE invoices SET paid_receipt = ?, paid_tx = ? WHERE invoice_ref = ?")
        .run(receiptId, txHash, invoiceRef);
      this.db.exec("COMMIT");
      return "ok";
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private rollback(result: ConsumeResult): ConsumeResult {
    this.db.exec("ROLLBACK");
    return result;
  }
}
