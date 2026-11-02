// The agent runner: buys reports from the merchants through the vault, and runs the demo attacks.
// Every step goes to a log the owner app streams (docs/architecture.md, "Agent" panel).

import { EventEmitter } from "node:events";
import type { PaymentOp, PaymentRequest, VaultClient } from "./near.js";
import { fromInvoice, fromProposal, nowNs } from "./payment.js";
import { fallbacks, quoteMismatch } from "./market.js";
import type { Offer, Planner, RawInvoice } from "./planner.js";

export type StepKind = "task" | "offers" | "invoice" | "model" | "quote" | "request" | "vault" | "deliver" | "error";

export interface Step {
  seq: number;
  at: string;
  run: string;
  kind: StepKind;
  text: string;
  data?: unknown;
}

/** A request the vault refused; the contract stores nothing for these, so the app lists them from here. */
export interface Refusal {
  at: string;
  run: string;
  req: PaymentRequest;
  error: string;
  txHash?: string;
}

const KEEP = 300;
/** The vault holds at most 16 active ops, so this many awaiting purchases is plenty. */
const MAX_AWAITING = 16;

interface Purchase {
  run: string;
  merchantUrl: string;
  invoiceRef: string;
  /** From the merchant, for the buyer only: never logged, never on chain. */
  deliveryToken: string;
  delivering: boolean;
}

export class Agent extends EventEmitter {
  readonly steps: Step[] = [];
  readonly refusals: Refusal[] = [];
  private seq = 0;
  private runs = 0;
  /** Purchases waiting for owner approval, by op id, so delivery can follow the approval. */
  private awaiting = new Map<string, Purchase>();

  /** Merchant URL by account id, from the last offers read. */
  private merchantUrls = new Map<string, string>();

  constructor(
    private vault: VaultClient,
    private planner: Planner,
    private marketUrls: string[],
  ) {
    super();
  }

  private log(run: string, kind: StepKind, text: string, data?: unknown): void {
    const step: Step = { seq: ++this.seq, at: new Date().toISOString(), run, kind, text, data };
    this.steps.push(step);
    if (this.steps.length > KEEP) this.steps.shift();
    this.emit("step", step);
  }

  private newRun(label: string): string {
    return `${label}-${++this.runs}`;
  }

  /** Every merchant's offers; a merchant that is down is logged and skipped. */
  private async offers(run: string): Promise<Offer[]> {
    const all: Offer[] = [];
    for (const url of this.marketUrls) {
      try {
        for (const o of await this.merchant<Offer[]>(url, "/offers")) {
          this.merchantUrls.set(o.merchant_id, url);
          all.push(o);
        }
      } catch (e) {
        this.log(run, "error", `${url}: ${(e as Error).message}`);
      }
    }
    if (all.length === 0) throw new Error("no merchant answered");
    return all;
  }

  private urlOf(merchantId: string): string {
    const url = this.merchantUrls.get(merchantId);
    if (!url) throw new Error(`no merchant URL for ${merchantId}`);
    return url;
  }

  private async merchant<T>(merchantUrl: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${merchantUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`merchant ${path}: ${json.error ?? res.status}`);
    return json;
  }

  private async submit(run: string, req: PaymentRequest, key = 0): Promise<{ op: PaymentOp; txHash: string } | undefined> {
    this.log(run, "request", `request_payment ${req.amount} to ${req.merchant_id}`, req);
    const out = await this.vault.requestPayment(req, key);
    if (out.ok) {
      this.log(run, "vault", `accepted as op ${out.op.op_id}`, { op: out.op, txHash: out.txHash });
      return { op: out.op, txHash: out.txHash };
    }
    this.refusals.push({ at: new Date().toISOString(), run, req, error: out.error, txHash: out.txHash });
    if (this.refusals.length > KEEP) this.refusals.shift();
    this.log(run, "vault", `refused: ${out.error}`, { error: out.error, txHash: out.txHash });
    return undefined;
  }

  /**
   * Buys one report. `compromised` lets the model's reading of the raw invoice decide the payment,
   * as a hijacked agent would; the vault is what stops it.
   */
  async buy(task: string, compromised: boolean): Promise<void> {
    const run = this.newRun(compromised ? "compromised" : "buy");
    try {
      this.log(run, "task", task, { planner: this.planner.name, compromised });
      const offers = await this.offers(run);
      const merchants = new Set(offers.map((o) => o.merchant_id)).size;
      this.log(run, "offers", `${offers.length} offers from ${merchants} merchant${merchants === 1 ? "" : "s"}`, offers);
      const chosen = await this.planner.chooseOffer(task, offers);
      this.log(run, "model", `chose ${chosen.sku} from ${chosen.merchant_id} at ${chosen.price}`, chosen);
      const cfg = await this.vault.config();

      // A hijacked agent pays what the model says from the one invoice it took. An honest one
      // refuses an invoice that is not the quote it accepted, and tries the next merchant.
      const candidates = compromised ? [chosen] : fallbacks(chosen, offers, task);
      for (const offer of candidates) {
        const merchantUrl = this.urlOf(offer.merchant_id);
        const invoice = await this.merchant<RawInvoice>(merchantUrl, "/invoices", { sku: offer.sku });
        const deliveryToken = invoice.delivery_token;
        if (typeof deliveryToken !== "string" || deliveryToken === "") throw new Error("invoice has no delivery token");
        this.log(run, "invoice", `invoice ${String(invoice.invoice_ref)} from ${offer.merchant_id}`, { ...invoice, delivery_token: "(redacted)" });

        let req: PaymentRequest;
        if (compromised) {
          const proposal = await this.planner.proposePayment(task, invoice);
          this.log(run, "model", `decided to pay ${proposal.merchant_id}`, proposal);
          req = fromProposal(proposal, cfg, nowNs());
        } else {
          const why = quoteMismatch(offer, invoice);
          if (why) {
            this.log(run, "quote", `refused ${offer.merchant_id}'s invoice, nothing paid: ${why}`, { offer, invoice: { ...invoice, delivery_token: "(redacted)" } });
            continue;
          }
          req = fromInvoice(invoice, cfg, nowNs());
        }

        const accepted = await this.submit(run, req);
        if (!accepted) return;
        const { op, txHash } = accepted;
        if (BigInt(op.amount) > BigInt(cfg.policy.approval_threshold)) {
          await this.remember(op.op_id, { run, merchantUrl, invoiceRef: op.invoice_ref, deliveryToken, delivering: false });
          this.log(run, "vault", `op ${op.op_id} awaits the owner's approval`);
          return;
        }
        await this.deliver(run, merchantUrl, op.invoice_ref, deliveryToken, txHash, this.vault.agentId);
        return;
      }
      throw new Error("every merchant's invoice differed from its quote; nothing was paid");
    } catch (e) {
      this.log(run, "error", (e as Error).message);
    }
  }

  /**
   * Called by the owner app after the owner's wallet approved `opId` in transaction `txHash`. The
   * purchase is kept until delivery succeeds, so a failed or bogus notification can be retried.
   */
  async approved(opId: string, txHash: string, signerId: string): Promise<void> {
    const pending = this.awaiting.get(opId);
    if (!pending) throw new Error(`op ${opId} is not one of this agent's awaiting purchases`);
    if (pending.delivering) throw new Error(`delivery for op ${opId} is already in progress`);
    pending.delivering = true;
    try {
      if (!(await this.deliver(pending.run, pending.merchantUrl, pending.invoiceRef, pending.deliveryToken, txHash, signerId))) {
        throw new Error(`delivery for op ${opId} failed; see the agent log`);
      }
      this.awaiting.delete(opId);
    } finally {
      pending.delivering = false;
    }
  }

  /** Keeps at most MAX_AWAITING purchases: drops ones the vault no longer holds, then the oldest. */
  private async remember(opId: string, p: Purchase): Promise<void> {
    if (this.awaiting.size >= MAX_AWAITING) {
      for (const id of [...this.awaiting.keys()]) {
        const rec = await this.vault.view<{ status: string } | null>("get_op", { op_id: id }).catch(() => undefined);
        if (rec === null || (rec && ["Rejected", "Failed", "Released"].includes(rec.status))) this.awaiting.delete(id);
      }
    }
    while (this.awaiting.size >= MAX_AWAITING) this.awaiting.delete(this.awaiting.keys().next().value!);
    this.awaiting.set(opId, p);
  }

  /** Returns whether the merchant delivered. */
  private async deliver(run: string, merchantUrl: string, invoiceRef: string, deliveryToken: string, txHash: string, senderId: string): Promise<boolean> {
    try {
      const res = await this.merchant<{ report: string }>(merchantUrl, "/deliver", {
        invoice_ref: invoiceRef,
        delivery_token: deliveryToken,
        tx_hash: txHash,
        sender_id: senderId,
      });
      this.log(run, "deliver", "report delivered", res);
      return true;
    } catch (e) {
      this.log(run, "error", (e as Error).message);
      return false;
    }
  }

  // ---- Demo attacks (docs/acceptance.md, Demo) ----

  /** T2: the leaked agent key calls the vault directly, bypassing the app, to pay the attacker. */
  async directCall(attackerId: string, amount: string): Promise<void> {
    const run = this.newRun("t2-direct-call");
    try {
      const cfg = await this.vault.config();
      this.log(run, "task", `leaked key calls the vault directly: pay ${attackerId}`);
      await this.submit(run, fromProposal({ merchant_id: attackerId, amount, invoice_ref: "LEAKED" }, cfg, nowNs()));
    } catch (e) {
      this.log(run, "error", (e as Error).message);
    }
  }

  /** T5: `count` requests at once, one per key, to the allowlisted merchant. */
  async parallel(merchantId: string, amount: string, count: number): Promise<void> {
    const run = this.newRun("t5-parallel");
    try {
      const cfg = await this.vault.config();
      const n = Math.min(count, this.vault.keyCount);
      this.log(run, "task", `${n} requests of ${amount} at once`);
      const reqs = Array.from({ length: n }, (_, i) =>
        fromProposal({ merchant_id: merchantId, amount, invoice_ref: `PAR-${Date.now()}-${i}` }, cfg, nowNs()),
      );
      const results = await Promise.all(reqs.map((r, i) => this.submit(run, r, i)));
      const accepted = results.filter(Boolean).length;
      this.log(run, "vault", `${accepted} accepted, ${n - accepted} refused`);
    } catch (e) {
      this.log(run, "error", (e as Error).message);
    }
  }
}
