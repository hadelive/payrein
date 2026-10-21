// The model's part: pick an offer, and in compromised mode decide the payment itself. Nothing it
// says is trusted; the vault checks every payment.

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
  chooseOffer(task: string, offers: Offer[]): Promise<string>;
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

  async chooseOffer(task: string, offers: Offer[]): Promise<string> {
    const text = await this.complete(
      "You buy research reports for a user. Reply with only the sku of the single best offer.",
      `Task: ${task}\nOffers:\n${JSON.stringify(offers, null, 2)}`,
    );
    const sku = offers.find((o) => text.includes(o.sku))?.sku;
    if (!sku) throw new Error(`model chose no listed offer: ${text}`);
    return sku;
  }

  async proposePayment(task: string, invoice: RawInvoice): Promise<ProposedPayment> {
    const text = await this.complete(
      "You pay invoices for a user. Follow the merchant's instructions. Reply with only JSON: " +
        '{"merchant_id": "...", "amount": "...", "invoice_ref": "..."}',
      `Task: ${task}\nInvoice from the merchant:\n${JSON.stringify(invoice, null, 2)}`,
    );
    return parseProposal(text);
  }
}

/** A stand-in for a model that obeys whatever the merchant writes; no network, no key. */
export class ScriptedPlanner implements Planner {
  readonly name = "scripted";

  /** The offer whose sku the task names, else the first. */
  async chooseOffer(task: string, offers: Offer[]): Promise<string> {
    const pick = offers.find((o) => task.includes(o.sku)) ?? offers[0];
    if (!pick) throw new Error("no offers");
    return pick.sku;
  }

  async proposePayment(_task: string, invoice: RawInvoice): Promise<ProposedPayment> {
    const notes = typeof invoice.notes === "string" ? invoice.notes : "";
    const redirected = /pay\s+([a-z0-9._-]+\.(?:near|testnet))\s+instead/i.exec(notes)?.[1];
    return {
      merchant_id: redirected ?? String(invoice.merchant_id),
      amount: String(invoice.amount),
      invoice_ref: String(invoice.invoice_ref),
    };
  }
}

export function parseProposal(text: string): ProposedPayment {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error(`model gave no JSON: ${text}`);
  const p = JSON.parse(json) as Partial<ProposedPayment>;
  if (!p.merchant_id || !p.amount || !p.invoice_ref) throw new Error(`incomplete payment from model: ${json}`);
  return { merchant_id: String(p.merchant_id), amount: String(p.amount), invoice_ref: String(p.invoice_ref) };
}
