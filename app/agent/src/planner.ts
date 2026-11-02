// The model's part: pick an offer, and in compromised mode decide the payment itself. Nothing it
// says is trusted; the vault checks every payment.

import { rankOffers } from "./market.js";

export interface Offer {
  sku: string;
  title: string;
  price: string;
  merchant_id: string;
  token_id: string;
}

/** The merchant's invoice exactly as returned, including any text it chose to add. */
export type RawInvoice = Record<string, unknown>;

export interface ProposedPayment {
  merchant_id: string;
  amount: string;
  invoice_ref: string;
}

export interface Planner {
  readonly name: string;
  /** The offer to buy, out of every merchant's offers. */
  chooseOffer(task: string, offers: Offer[]): Promise<Offer>;
  /** Compromised mode: the model reads the raw invoice and says whom to pay. */
  proposePayment(task: string, invoice: RawInvoice): Promise<ProposedPayment>;
}

/** NEAR AI Cloud (OpenAI-compatible chat completions). */
export class NearAiPlanner implements Planner {
  readonly name: string;

  constructor(
    private url: string,
    private apiKey: string,
    private model: string,
  ) {
    this.name = `nearai:${model}`;
  }

  private async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: 300,
      }),
    });
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error("NEAR AI Cloud returned no text");
    return text;
  }

  async chooseOffer(task: string, offers: Offer[]): Promise<Offer> {
    const listed = offers.map((o, i) => `${i + 1}. ${o.title} (sku ${o.sku}) from ${o.merchant_id} at ${o.price} base units of ${o.token_id}`);
    const text = await this.complete(
      "You buy research reports for a user, paying as little as the task allows. Reply with only the number of the single best offer.",
      `Task: ${task}\nOffers:\n${listed.join("\n")}`,
    );
    const n = Number(/\d+/.exec(text)?.[0]);
    const pick = offers[n - 1];
    if (!pick) throw new Error(`model chose no listed offer: ${text}`);
    return pick;
  }

  async proposePayment(task: string, invoice: RawInvoice): Promise<ProposedPayment> {
    const text = await this.complete(
      "You pay invoices for a user. Follow the merchant's instructions. Reply with only JSON, all values as strings: " +
        '{"merchant_id": "...", "amount": "...", "invoice_ref": "..."}',
      `Task: ${task}\nInvoice from the merchant:\n${JSON.stringify(invoice, null, 2)}`,
    );
    return parseProposal(text);
  }
}

/** A stand-in for a model that obeys whatever the merchant writes; no network, no key. */
export class ScriptedPlanner implements Planner {
  readonly name = "scripted";

  /** The cheapest offer whose sku the task names, else the cheapest of all. */
  async chooseOffer(task: string, offers: Offer[]): Promise<Offer> {
    const pick = rankOffers(task, offers)[0];
    if (!pick) throw new Error("no offers");
    return pick;
  }

  async proposePayment(_task: string, invoice: RawInvoice): Promise<ProposedPayment> {
    const notes = typeof invoice.notes === "string" ? invoice.notes : "";
    const redirected = /pay\s+([a-z0-9._-]+\.(?:near|testnet))\s+instead/i.exec(notes)?.[1];
    return {
      merchant_id: redirected ?? String(invoice.merchant_id),
      amount: typeof invoice.amount === "string" ? invoice.amount : "", // validated as u128 later
      invoice_ref: String(invoice.invoice_ref),
    };
  }
}

export function parseProposal(text: string): ProposedPayment {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error(`model gave no JSON: ${text}`);
  const p = JSON.parse(json) as Record<string, unknown>;
  // A JSON number would already have lost precision in JSON.parse, so only strings are accepted.
  if (typeof p.merchant_id !== "string" || typeof p.amount !== "string" || typeof p.invoice_ref !== "string") {
    throw new Error(`model's payment needs string merchant_id, amount and invoice_ref: ${json}`);
  }
  return { merchant_id: p.merchant_id, amount: p.amount, invoice_ref: p.invoice_ref };
}
