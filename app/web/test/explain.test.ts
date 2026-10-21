// T21: amounts and sentences the owner reads are exact; decimals come from ft_metadata.

import { describe, expect, it } from "vitest";
import { explain, formatAmount, rejectionSentence, REJECTIONS } from "../src/explain.js";

const W = 10n ** 24n;
const ctx = {
  vaultId: "vault.owner.near",
  symbol: "wNEAR",
  decimals: 24,
  merchantLabel: "Report Shop",
  approvalThreshold: (W / 4n).toString(),
  budget: {
    daily_max: (5n * W).toString(),
    spent: ((12n * W) / 10n).toString(),
    reserved: ((3n * W) / 10n).toString(),
    remaining: ((35n * W) / 10n).toString(),
  },
};
const op = {
  op_id: "9007199254740993",
  merchant_id: "reports.merchant.near",
  token_id: "nep141:wrap.near",
  amount: (W / 2n).toString(),
  invoice_ref: "INV-42",
  expires_at_ns: "1793110500000000000",
  policy_version: 1,
};

describe("formatAmount", () => {
  it.each([
    ["1", "0.000001"], // 1 yocto is never shown as 0
    [(W / 4n).toString(), "0.25"],
    [(W / 2n).toString(), "0.5"],
    [W.toString(), "1"],
    [((W * 123456789n) / 100000000n).toString(), "1.234567"],
  ])("%s yocto is %s wNEAR", (base, text) => {
    expect(formatAmount(base, 24)).toBe(text);
  });

  it("uses the token's decimals", () => {
    expect(formatAmount("1500000", 6)).toBe("1.5");
  });
});

describe("explain", () => {
  it("matches the spec's template", () => {
    const e = explain(op, ctx);
    expect(e.headline).toBe(
      "Pay 0.5 wNEAR to Report Shop (reports.merchant.near, allowlisted) for invoice INV-42, from vault vault.owner.near.",
    );
    expect(e.budget).toBe("Today: 1.2 spent, 0.3 pending, limit 5; 3 left after this.");
    expect(e.reason).toBe("Needs your approval: above the 0.25 threshold.");
    expect(e.expires).toBe("Expires 14:15 UTC.");
  });

  it("says when a payment would exceed the limit", () => {
    const e = explain({ ...op, amount: (4n * W).toString() }, ctx);
    expect(e.budget).toContain("exceed today's limit by 0.5");
  });

  it("flags a recipient that is not allowlisted", () => {
    expect(explain(op, { ...ctx, merchantLabel: undefined }).merchant).toContain("not allowlisted");
  });
});

it("has a sentence for every vault code the owner can see", () => {
  for (const code of ["MerchantNotAllowed", "OverDaily", "ApprovalMismatch", "TooManyPending"]) {
    expect(REJECTIONS[code]).toBeDefined();
  }
  expect(rejectionSentence("Weird")).toBe("Refused: Weird.");
});
