// Supplier choice. The agent reads every merchant's offers, ranks the ones that fit the task by
// price, and refuses an invoice that is not the offer it accepted. The contract caps what any one
// payment can be; whether the price is the one quoted is the agent's own check (T26 in the threat
// model), and a refused quote costs nothing because no request reaches the vault.

import type { Offer, RawInvoice } from "./planner.js";

/** Offers whose sku the task names (all offers when it names none), cheapest first, stable. */
export function rankOffers(task: string, offers: Offer[]): Offer[] {
  const fitting = offers.filter((o) => task.includes(o.sku));
  const pool = fitting.length > 0 ? fitting : offers;
  return [...pool].sort((a, b) => {
    const [x, y] = [BigInt(a.price), BigInt(b.price)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The accepted offer first, then the other merchants' offers of the same sku, cheapest first. */
export function fallbacks(chosen: Offer, offers: Offer[], task: string): Offer[] {
  const rest = rankOffers(task, offers).filter((o) => o.sku === chosen.sku && o.merchant_id !== chosen.merchant_id);
  return [chosen, ...rest];
}

/** Why the invoice is not the offer that was accepted, or null when it is. */
export function quoteMismatch(offer: Offer, invoice: RawInvoice): string | null {
  if (invoice.merchant_id !== offer.merchant_id) {
    return `invoice is from ${String(invoice.merchant_id)}, the offer was ${offer.merchant_id}'s`;
  }
  if (invoice.token_id !== offer.token_id) return `invoice token ${String(invoice.token_id)}, the offer was in ${offer.token_id}`;
  // Only a decimal string counts: a JSON number would already have lost precision, and BigInt("") is 0.
  if (typeof invoice.amount !== "string" || !/^\d+$/.test(invoice.amount)) {
    return `invoice amount ${String(invoice.amount)} is not a number`;
  }
  const invoiced = BigInt(invoice.amount);
  if (invoiced !== BigInt(offer.price)) return `invoiced ${invoiced}, quoted ${offer.price}`;
  return null;
}
