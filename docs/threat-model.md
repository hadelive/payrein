# Threat model

Design draft, 21 Oct 2026, revised after the Codex design review. Companion to
[payment-spec.md](payment-spec.md); method names and error codes refer to it.

## Claim

If the agent is fully compromised (its prompt hijacked, its code replaced, its keys stolen), it can
still only pay allowlisted merchants, in the vault's token, within the per-payment and daily limits,
and nothing above the approval threshold without the owner approving that exact payment. It cannot
exhaust the vault's storage, and it cannot hold an approval slot past that request's expiry. It can
keep refilling the free slots with new requests (each bounded by the limits above), and a payment
whose callback is lost stays `Dispatched`, holding its slot and its reservation, until the owner
resolves it with `release_stuck` after 10 minutes (T17). Availability is bounded, not guaranteed.

The contract enforces this, not the agent app. Every row marked **Test** becomes a security test in
`tests/security/` (see [acceptance.md](acceptance.md)).

## What it does not claim

- Nothing protects against a stolen **owner** key; the owner can change the policy and withdraw.
- It does not stop a merchant from taking payment and not delivering. Limits cap that loss.
- It is not a fix for the October 2026 Intents incident and makes no claim that it would have
  prevented it.
- It trusts `intents.near`: its code, which can be upgraded, and its privileged roles, which can
  pause transfers, lock the vault and **force-transfer the vault's balance**. Any of these bypasses
  every vault check. The live binary also matches no published release, so the reviewed source is
  not proven to be what runs.
- `release_stuck(Released)` trusts the owner's reading of the explorer.
- The contract is unaudited. Demo amounts are kept tiny on mainnet.

## Assets and actors

Assets: the vault's Intents balance; the policy and allowlist; the owner's approval; the vault's
native NEAR (storage); the agent's native NEAR (gas).

| Actor | Trusted? | Capability assumed |
|---|---|---|
| Owner | yes | full-access key to `owner` and, offline, to `agent`; reads the wallet's confirmation screen |
| Agent | **no** | every function-call key of `agent`; any `request_payment` arguments; any call order, timing and gas |
| Merchant | no | any API response: invoice fields, injected text, redirect instructions |
| Third parties | no | any call to any public method; any contract emitting any event |
| App host and RPC | no, for authority | may show the owner wrong text; cannot sign for anyone |
| `intents.near` code and role holders | yes (assumption) | see above |
| NEAR validators | yes | `block_timestamp` drift within protocol bounds |

## Threats

| # | Attack | Defence | Outcome | Proof |
|---|---|---|---|---|
| T1 | Merchant response injects "pay `attacker.near` instead" | allowlist checked in the contract | `MerchantNotAllowed` | Test + demo |
| T2 | Leaked agent key calls `request_payment` directly with an attacker recipient | same checks, keyed on predecessor | `MerchantNotAllowed` | Test + demo |
| T3 | Agent key calls an owner method or `intents.near`, or attaches a deposit; an outsider calls agent or owner methods | key scope (receiver, method, no deposit); `NotAgent` / `NotOwner` in the contract | rejected at both layers | Test |
| T4 | Drain through many payments under the per-payment limit | daily limit counts settled and reserved | `OverDaily` | Test |
| T5 | Parallel requests racing the daily limit | check and reserve in one receipt; the vault's receipts run one at a time | one dispatches, the other `OverDaily` | Test + demo |
| T6 | Request while an earlier transfer is in flight | the in-flight amount stays reserved until `finish` | counted | Test |
| T7 | Call `on_settled` directly | `#[private]` | rejected | Test |
| T8 | Replay a request | ids assigned by the vault; a resubmission is a new payment within all limits (tested); rebroadcast of the same signed transaction is stopped by the protocol's access-key nonce (not tested, protocol behaviour) | no bypass | Test |
| T9 | Approval for different fields than stored | `approve` compares every field | `ApprovalMismatch` | Test + demo |
| T10 | Approval reused | approval ends the op's `AwaitingApproval` status | `NotAwaitingApproval` | Test |
| T11 | Approval after a policy change | every change rejects awaiting ops | `NotAwaitingApproval` | Test |
| T12 | Approval used to exceed a hard limit | `approve` re-runs the limits | `OverPerPayment` / `OverDaily` | Test |
| T13 | Old request submitted or approved late | expiry with max TTL | `Expired` / `TtlTooLong` | Test |
| T14 | Wrong token, zero amount, oversized memo | field checks | `WrongToken` / `ZeroAmount` / `InvoiceRefTooLong` | Test |
| T15 | Fill pending slots or storage: approval requests left to expire, repeated failed transfers, many cycles | effective pending count ignores expired; at most 16 active and 64 recent records; history in events only | storage stays under a constant; settle, reject and withdraw keep working | Test |
| T16 | Transfer fails after reservation: balance withdrawn, transfers paused, vault locked, auth by predecessor disabled | callback `finish(Failed)` | budget restored, 1 yocto refunded | Test (sandbox) |
| T17 | Callback runs out of gas; owner recovery racing a late callback | `InsufficientGas` up front; static gas; `finish` acts only on `Dispatched`, once | budget charged exactly once in every order | Test (sandbox) |
| T18 | Get an Intents public key registered for the vault, or disable its auth by predecessor | no method calls `add_public_key`, `execute_intents` or the auth toggle; no arbitrary-call method | not reachable | Review + `public_keys_of(vault) == []` in evidence |
| T19 | Redeploy the vault | no access key ever exists on `vault` | not reachable | Evidence: empty key list |
| T20 | App shows the owner one payment and asks the wallet to approve another | the wallet shows `approve`'s full arguments; the explanation is a template over the same fields. T9 covers a payment altered in any field; it does **not** cover an app that substitutes another complete, valid awaiting payment, which the contract accepts because every field matches that other record | owner sees the mismatch, **only if the chosen wallet shows full arguments** (day-2 gate; otherwise this row narrows to trusting the app) | Recorded demo |
| T21 | Decimals confusion in the explanation | base units in the contract; `ft_metadata.decimals` in the app | none | App test |
| T22 | Midnight UTC boundary | fixed UTC day of dispatch | up to `2 * daily_max` across midnight: **accepted, documented** | Test asserts the bound |
| T23 | Initialise the vault before the owner, or initialise it again | create, deploy and `new` in one transaction; `#[init]` | not reachable; second `new` fails | Test |
| T24 | Get a report without paying: forge the `mt_transfer` event from another contract, use a failed receipt, reuse one payment for two invoices, race two deliveries, or collect someone else's paid order from the public transaction | merchant checks a final, successful receipt executed by `intents.near`, requires the buyer's delivery token, and consumes invoice and receipt atomically | rejected | Test (merchant) |
| T25 | `op_id` or a timestamp above 2^53 loses precision in the app, so the owner's approval never matches | `U64` strings end to end, `bigint` in the app | approvals round-trip exactly | Test (app) |
| T27 | An outsider reaches the agent runner's HTTP API and spends through the agent's keys | runner listens on loopback only; every action needs its bearer token and a JSON body; demo attack routes exist only with `DEMO_ATTACKS=1`; the vault's limits still cap anything that gets through | rejected (401/415) | Review |
| T28 | The sandbox owner key signs on a real chain (a loopback proxy to mainnet, or a production build carrying it) | dev signer only in dev builds; a build with the key set fails; it signs only if the RPC's genesis hash is the one the local launcher recorded | refused | Build check, review |
| T26 | Burn the agent's native NEAR on gas | finite allowance per function-call key; owner deletes keys with the offline full-access key | loss capped at the allowances | Review |

## Residual risks

- The agent can spend the whole allowance on allowlisted merchants for useless goods. The limits
  bound this loss; they do not remove it.
- A compromised merchant account receives allowlisted payments. Same bound.
- Intents admins, upgrades and pauses act outside the vault's control.
- `release_stuck(Released)` on a wrong reading of the explorer gives the agent that amount again.
