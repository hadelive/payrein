// Builds the vault request from the merchant's structured invoice fields (the honest path).

import type { PaymentRequest, VaultConfig } from "./near.js";
import type { ProposedPayment, RawInvoice } from "./planner.js";

/** Slack left under the vault's max TTL for clock skew and block time: 30 s, or a tenth of short TTLs. */
const MAX_TTL_MARGIN_NS = 30n * 1_000_000_000n;
const U128_MAX = (1n << 128n) - 1n;

/** A positive u128 as a decimal string, or an error naming `what`. Never coerces numbers (T25). */
export function u128(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[0-9]{1,39}$/.test(value)) throw new Error(`${what} must be a decimal string`);
  const v = BigInt(value);
  if (v === 0n || v > U128_MAX) throw new Error(`${what} is out of range`);
  return v.toString();
}

function field(invoice: RawInvoice, name: string): string {
  const v = invoice[name];
  if (typeof v !== "string" || v === "") throw new Error(`invoice field ${name} missing`);
  return v;
}

/** Expiry: the invoice's, capped to what the vault's TTL allows from `nowNs`. */
export function expiry(invoiceExpiresNs: string, nowNs: bigint, maxTtlSec: number): string {
  const ttl = BigInt(maxTtlSec) * 1_000_000_000n;
  const margin = ttl / 10n < MAX_TTL_MARGIN_NS ? ttl / 10n : MAX_TTL_MARGIN_NS;
  const cap = nowNs + ttl - margin;
  const inv = BigInt(invoiceExpiresNs);
  if (inv <= nowNs) throw new Error("invoice already expired");
  return (inv < cap ? inv : cap).toString();
}

export function fromInvoice(invoice: RawInvoice, cfg: VaultConfig, nowNs: bigint): PaymentRequest {
  return {
    merchant_id: field(invoice, "merchant_id"),
    token_id: field(invoice, "token_id"),
    amount: u128(invoice.amount, "invoice amount"),
    invoice_ref: field(invoice, "invoice_ref"),
    expires_at_ns: expiry(u128(invoice.expires_at_ns, "invoice expiry"), nowNs, cfg.policy.max_ttl_sec),
    policy_version: cfg.policy.version,
  };
}

/** Compromised mode: the model's proposal decides recipient, amount and reference. */
export function fromProposal(p: ProposedPayment, cfg: VaultConfig, nowNs: bigint): PaymentRequest {
  return {
    merchant_id: p.merchant_id,
    token_id: cfg.policy.token_id,
    amount: u128(p.amount, "proposed amount"),
    invoice_ref: p.invoice_ref,
    expires_at_ns: expiry((nowNs + 600n * 1_000_000_000n).toString(), nowNs, cfg.policy.max_ttl_sec),
    policy_version: cfg.policy.version,
  };
}

export function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}
