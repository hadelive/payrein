// Builds the vault request from the merchant's structured invoice fields (the honest path).

import type { PaymentRequest, VaultConfig } from "./near.js";
import type { ProposedPayment, RawInvoice } from "./planner.js";

/** Leaves the vault this much slack under its max TTL for clock skew and block time. */
const TTL_MARGIN_NS = 30n * 1_000_000_000n;

function field(invoice: RawInvoice, name: string): string {
  const v = invoice[name];
  if (typeof v !== "string" || v === "") throw new Error(`invoice field ${name} missing`);
  return v;
}

/** Expiry: the invoice's, capped to what the vault's TTL allows from `nowNs`. */
export function expiry(invoiceExpiresNs: string, nowNs: bigint, maxTtlSec: number): string {
  const cap = nowNs + BigInt(maxTtlSec) * 1_000_000_000n - TTL_MARGIN_NS;
  const inv = BigInt(invoiceExpiresNs);
  return (inv < cap ? inv : cap).toString();
}

export function fromInvoice(invoice: RawInvoice, cfg: VaultConfig, nowNs: bigint): PaymentRequest {
  return {
    merchant_id: field(invoice, "merchant_id"),
    token_id: field(invoice, "token_id"),
    amount: field(invoice, "amount"),
    invoice_ref: field(invoice, "invoice_ref"),
    expires_at_ns: expiry(field(invoice, "expires_at_ns"), nowNs, cfg.policy.max_ttl_sec),
    policy_version: cfg.policy.version,
  };
}

/** Compromised mode: the model's proposal decides recipient, amount and reference. */
export function fromProposal(p: ProposedPayment, cfg: VaultConfig, nowNs: bigint): PaymentRequest {
  return {
    merchant_id: p.merchant_id,
    token_id: cfg.policy.token_id,
    amount: p.amount,
    invoice_ref: p.invoice_ref,
    expires_at_ns: expiry((nowNs + 600n * 1_000_000_000n).toString(), nowNs, cfg.policy.max_ttl_sec),
    policy_version: cfg.policy.version,
  };
}

export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}
