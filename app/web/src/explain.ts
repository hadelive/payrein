// The explanation the owner reads before approving (docs/payment-spec.md, "Explanation shown to
// the owner"). A fixed template over the same fields the contract checks; no model involved.

export interface PaymentOp {
  op_id: string;
  merchant_id: string;
  token_id: string;
  amount: string;
  invoice_ref: string;
  expires_at_ns: string;
  policy_version: number;
}

export interface Budget {
  daily_max: string;
  spent: string;
  reserved: string;
  remaining: string;
}

export interface ExplainContext {
  vaultId: string;
  symbol: string;
  decimals: number;
  merchantLabel?: string;
  approvalThreshold: string;
  budget: Budget;
}

/** Like formatAmount, but for untrusted text (e.g. the agent's log): non-numbers are shown as given. */
export function safeAmount(base: string, decimals: number, shown = 6): string {
  return /^-?[0-9]{1,78}$/.test(base) ? formatAmount(base, decimals, shown) : base;
}

/** `base` units as a decimal string with at most `shown` fraction digits, trailing zeros trimmed. */
export function formatAmount(base: string | bigint, decimals: number, shown = 6): string {
  const v = BigInt(base);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  let frac = (abs % unit).toString().padStart(decimals, "0").slice(0, shown).replace(/0+$/, "");
  if (frac === "" && abs % unit !== 0n) frac = "0".repeat(shown - 1) + "1"; // never show a nonzero amount as 0
  const text = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${text}` : text;
}

export function utcTime(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(11, 16) + " UTC";
}

export interface Explanation {
  headline: string;
  merchant: string;
  budget: string;
  reason?: string;
  expires: string;
}

export function explain(op: PaymentOp, ctx: ExplainContext): Explanation {
  const amt = (x: string | bigint) => formatAmount(x, ctx.decimals, 4);
  const after = BigInt(ctx.budget.remaining) - BigInt(op.amount);
  const listed = ctx.merchantLabel ? `${ctx.merchantLabel} (${op.merchant_id}, allowlisted)` : `${op.merchant_id} (not allowlisted)`;
  return {
    headline: `Pay ${amt(op.amount)} ${ctx.symbol} to ${listed} for invoice ${op.invoice_ref}, from vault ${ctx.vaultId}.`,
    merchant: listed,
    budget:
      `Today: ${amt(ctx.budget.spent)} spent, ${amt(ctx.budget.reserved)} pending, limit ${amt(ctx.budget.daily_max)}; ` +
      (after >= 0n ? `${amt(after)} left after this.` : `this would exceed today's limit by ${amt(-after)}.`),
    reason:
      BigInt(op.amount) > BigInt(ctx.approvalThreshold)
        ? `Needs your approval: above the ${amt(ctx.approvalThreshold)} threshold.`
        : undefined,
    expires: `Expires ${utcTime(op.expires_at_ns)}.`,
  };
}

/** One fixed sentence per vault error code. */
export const REJECTIONS: Record<string, string> = {
  Paused: "The vault is paused.",
  NotAgent: "The caller is not the vault's agent.",
  InsufficientGas: "Not enough gas was attached to pay and record the result.",
  PolicyVersionMismatch: "The request was built for an older policy.",
  Expired: "The request expired.",
  TtlTooLong: "The request's expiry is further out than the policy allows.",
  MerchantNotAllowed: "The recipient is not on the allowlist.",
  WrongToken: "The request uses a token the vault does not pay in.",
  ZeroAmount: "The amount is zero.",
  InvoiceRefTooLong: "The invoice reference is longer than 64 bytes.",
  OverPerPayment: "The amount is above the per-payment limit.",
  TooManyPending: "Too many payments are already pending.",
  OverDaily: "The payment would exceed today's limit.",
  ApprovalMismatch: "The approval did not match the stored payment in every field.",
  NotAwaitingApproval: "That payment is not waiting for approval.",
};

export function rejectionSentence(code: string): string {
  return REJECTIONS[code] ?? `Refused: ${code}.`;
}
