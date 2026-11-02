import { describe, expect, it } from "vitest";
import { fallbacks, quoteMismatch, rankOffers } from "../src/market.js";
import type { Offer } from "../src/planner.js";

const token = "nep141:wrap.test.near";
const shop = (sku: string, price: string): Offer => ({ sku, title: sku, price, merchant_id: "shop.test.near", token_id: token });
const desk = (sku: string, price: string): Offer => ({ sku, title: sku, price, merchant_id: "desk.test.near", token_id: token });
const offers = [shop("near-weekly", "2000"), shop("intents-deep-dive", "8000"), desk("near-weekly", "3000"), desk("intents-deep-dive", "6000")];

describe("rankOffers", () => {
  it("keeps the offers the task names, cheapest first", () => {
    expect(rankOffers("Buy near-weekly", offers).map((o) => [o.merchant_id, o.price])).toEqual([
      ["shop.test.near", "2000"],
      ["desk.test.near", "3000"],
    ]);
    expect(rankOffers("Buy intents-deep-dive", offers)[0]?.merchant_id).toBe("desk.test.near");
  });

  it("compares prices as integers, not strings", () => {
    const ranked = rankOffers("x", [shop("x", "10000"), desk("x", "9999")]);
    expect(ranked[0]?.price).toBe("9999");
  });

  it("falls back to every offer when the task names none", () => {
    expect(rankOffers("Buy something", offers)).toHaveLength(4);
  });
});

describe("fallbacks", () => {
  it("tries the accepted offer first, then the same sku from other merchants by price", () => {
    const chosen = desk("intents-deep-dive", "6000");
    expect(fallbacks(chosen, offers, "Buy intents-deep-dive").map((o) => o.merchant_id)).toEqual(["desk.test.near", "shop.test.near"]);
  });
});

describe("quoteMismatch (T26)", () => {
  const offer = desk("intents-deep-dive", "6000");
  const invoice = { merchant_id: "desk.test.near", token_id: token, amount: "6000", invoice_ref: "INV-1" };

  it("accepts the invoice that matches the offer", () => {
    expect(quoteMismatch(offer, invoice)).toBeNull();
    expect(quoteMismatch(offer, { ...invoice, amount: "006000" })).toBeNull();
  });

  it("refuses an invoice that asks more than quoted", () => {
    expect(quoteMismatch(offer, { ...invoice, amount: "9000" })).toBe("invoiced 9000, quoted 6000");
  });

  it("refuses an invoice from another merchant, in another token, or with a non-numeric amount", () => {
    expect(quoteMismatch(offer, { ...invoice, merchant_id: "attacker.test.near" })).toMatch(/is from attacker/);
    expect(quoteMismatch(offer, { ...invoice, token_id: "nep141:usdc.test.near" })).toMatch(/token/);
    expect(quoteMismatch(offer, { ...invoice, amount: "six" })).toMatch(/not a number/);
    expect(quoteMismatch(offer, { ...invoice, amount: 6000 })).toMatch(/not a number/);
  });
});
