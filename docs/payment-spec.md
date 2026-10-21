# Payment operation spec

Design draft, 21 Oct 2026, written before the build window (1–14 Nov). No code yet. Revised the
same day after a Codex design review (14 findings, all accepted).

The vault is a NEAR contract that holds a balance inside NEAR Intents (`intents.near`) and pays
allowlisted merchants on an agent's request, within limits the contract enforces itself.

## Accounts

| Account | Keys | Can do |
|---|---|---|
| `owner` (owner's wallet) | owner's full-access key | every owner method below |
| `vault.<owner>` (the contract) | **none, ever**: created, funded, deployed and initialised in one transaction with no `AddKey` | holds the Intents balance; only its own code moves it |
| `agent` (agent runner) | full-access key held offline by the owner (rotation, recovery); up to 8 function-call keys, each receiver `vault`, methods `[request_payment]`, allowance 0.25 NEAR | request payments |
| `merchant` (each one) | its own | receives `mt_transfer` into its Intents balance |

The vault never registers a public key in `intents.near`, never calls `execute_intents`, never
toggles auth by predecessor, and has no arbitrary-call method. Its only authority there is
"predecessor is `vault`".

The agent's native NEAR (gas) is a separate asset from the vault's wNEAR. A compromised agent can
burn at most the remaining allowance of each key, and the owner can delete keys with the offline
full-access key.

## Deployment

One transaction from `owner` to the new sub-account `vault.<owner>`: `CreateAccount`,
`Transfer` (storage for the bounded maximum below plus headroom), `DeployContract`,
`FunctionCall new(owner, agent, policy, merchants)`. No `AddKey`, so nobody can front-run the
initialisation and nobody can redeploy. `new` is `#[init]`; a second call fails because state
exists.

Before funding Intents, the owner app checks: code hash equals the published build,
`get_config()` returns the expected owner, agent, policy and allowlist, the access key list is
empty. Only then: `wrap.near.ft_transfer_call(receiver_id: "intents.near", amount, msg: "<vault>")`.

## Facts verified (read-only, 21 Oct 2026)

Source: `near/intents` main at `75d2976949` (2026-10-20). Live: `intents.near` on mainnet, code hash
`BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, which matches no published `defuse.wasm` release.
Reviewed source and the live binary are therefore not proven to correspond.

- `mt_transfer(receiver_id, token_id, amount, approval, memo)` requires exactly 1 yoctoNEAR,
  rejects `approval`, and debits `env::predecessor_account_id()` after `ensure_auth_predecessor_id`
  (`contracts/defuse/src/contract/tokens/nep245/core.rs`). It is an atomic ledger move: it calls
  no merchant code and has no resolve step, so a successful receipt means the merchant was paid.
- For a fresh named account, mainnet views return `is_auth_by_predecessor_id_enabled = true`,
  `public_keys_of = []`, `is_account_locked = false`.
- `DepositMessage` parses a plain account ID, so the deposit above credits `vault`.
- Intents privileged roles can act on any account, the vault included:
  DAO / UnrestrictedAccountLocker / UnrestrictedAccountManager can lock it
  (`accounts/force.rs`); DAO / UnrestrictedWithdrawer can **force-transfer its balance**
  (`tokens/nep245/force.rs`); DAO / Upgrader can **replace the contract** (`upgrade.rs`); DAO /
  PauseManager can pause transfers. These bypass every vault check and are a stated trust
  assumption.

## Data

All 64- and 128-bit numbers cross JSON as decimal strings (`U64`, `U128`). The app keeps them as
`bigint` or strings, never `number`.

```rust
const MAX_ACTIVE: usize = 16;     // AwaitingApproval + Dispatched, hard cap
const RECENT: usize = 64;         // finished records kept; older ones only in events
const MAX_MERCHANTS: usize = 32;  // label <= 32 bytes
const STUCK_AFTER_NS: u64 = 10 * 60 * 1_000_000_000;

struct Policy {
    version: u32,                 // bumped by every owner change
    token_id: String,             // "nep141:wrap.near" for the MVP; one token only
    per_payment_max: U128,        // <= daily_max
    daily_max: U128,              // per UTC day of dispatch, floor(block_timestamp / 86_400e9)
    approval_threshold: U128,     // amount > threshold needs owner approval; <= per_payment_max
    max_ttl_sec: u32,
    max_pending: u16,             // <= MAX_ACTIVE
    paused: bool,
}

struct PaymentRequest {           // what the agent submits
    merchant_id: AccountId,
    token_id: String,
    amount: U128,                 // base units
    invoice_ref: String,          // <= 64 bytes
    expires_at_ns: U64,
    policy_version: u32,
}

struct PaymentOp { op_id: U64, req: PaymentRequest }   // op_id assigned by the vault

enum OpStatus { AwaitingApproval, Dispatched, Settled, Failed, Rejected, Released }

struct OpRecord {
    op: PaymentOp, status: OpStatus,
    day: Option<u64>,             // UTC day of dispatch; None until dispatched
    created_ns: U64, dispatched_ns: Option<U64>, finished_ns: Option<U64>,
}

next_op_id: u64
active: IterableMap<u64, OpRecord>        // len <= MAX_ACTIVE
recent: [Option<OpRecord>; RECENT] ring    // fixed slots, overwritten
today: (u64 /*day*/, u128 /*settled spend*/)
```

Storage is bounded by a constant: config, at most 32 merchants, 16 active and 64 recent records of
bounded size, one day counter. The vault is funded for that maximum at deployment, so no request
or callback can run out of storage.

Every state change emits an NEP-297 event (`standard: "agent_vault"`): `requested`,
`awaiting_approval`, `dispatched`, `settled`, `failed`, `rejected`, `released`,
`late_resolution_ignored`, `policy_changed`. Events are the permanent history.

Budget for today: `spent_today + reserved_today`, where `spent_today` is `today.1` if `today.0`
is the current day (else 0) and `reserved_today` is the sum of `Dispatched` ops in `active` with
`day == current day` (at most 16 to add). Invariant: at every dispatch,
`spent_today + reserved_today + amount <= daily_max`, all with checked arithmetic.

Effective pending count: `Dispatched` ops plus `AwaitingApproval` ops not yet expired. Expired
ones never hold a slot, whether or not cleanup has run.

## Methods

Agent (`predecessor == agent`, not payable; the 1 yocto comes from the vault's NEAR balance):

- `request_payment(req: PaymentRequest) -> PaymentOp`
  1. Checks in this order, each failing with its code: `Paused`, `NotAgent`, `InsufficientGas`
     (remaining gas below `GAS_MT_TRANSFER + GAS_ON_SETTLED + GAS_SELF`), `PolicyVersionMismatch`,
     `Expired` (`now >= expires_at`), `TtlTooLong`, `MerchantNotAllowed`, `WrongToken`,
     `ZeroAmount`, `InvoiceRefTooLong`, `OverPerPayment`, `TooManyPending` (effective count + 1 >
     `max_pending`), `OverDaily` (only when it would dispatch now).
  2. Assign `op_id = next_op_id++`, run cleanup.
  3. If `amount > approval_threshold`: store `AwaitingApproval`, reserve nothing, return.
  4. Otherwise `dispatch`.
  A failing check panics, so a rejected request stores nothing and costs only the caller's gas.
  Replay of the same transaction is stopped by NEAR's access-key nonce; a repeated request is a
  new payment and passes through every limit.

Owner (`predecessor == owner`, 1 yocto attached so a function-call key cannot call them):

- `approve(op: PaymentOp)`: the record `op.op_id` must be in `active` as `AwaitingApproval`
  (`NotAwaitingApproval`) and equal `op` in every field (`ApprovalMismatch`). Then `Paused`,
  `InsufficientGas`, `PolicyVersionMismatch`, `Expired`, `MerchantNotAllowed`, `OverPerPayment`
  and `OverDaily` run again; `TooManyPending` does not, since approval moves a slot from awaiting to
  dispatched without adding one. Then `dispatch`, which charges the day of approval. Approval lifts
  only the threshold and is consumed by this call.
- `reject(op_id)`: `AwaitingApproval` to `Rejected`.
- `set_policy`, `add_merchant`, `remove_merchant`, `set_agent`, `pause`, `unpause`: each validates
  its input (`per_payment_max <= daily_max`, `approval_threshold <= per_payment_max`,
  `max_pending <= MAX_ACTIVE`, merchant cap and label length), bumps `version`, and moves every
  `AwaitingApproval` op to `Rejected`. `Dispatched` ops are untouched and settle under the rules
  they were reserved under. Lowering `max_pending` below the current count blocks new requests until
  it drains.
- `withdraw(amount)`: `mt_transfer` to `owner`. It does not respect reservations: a `Dispatched`
  payment that then lacks balance fails and is released by its callback.
- `release_stuck(op_id, outcome: Settled | Released)`: only for an op `Dispatched` for at least
  `STUCK_AFTER_NS`. `Settled` charges it to its day (the app's default, the safe choice when the
  outcome is unknown). `Released` returns the budget and is allowed only on the owner's word that
  the transfer receipt finalised as failed; the contract cannot verify that, so it is a trusted-
  owner attestation and documented as such.

Anyone:

- `cleanup()`: moves expired `AwaitingApproval` ops to `Rejected` (at most 16). Also run inside
  every committing method.

Private:

- `dispatch(op)`: set `day`, `dispatched_ns`, status `Dispatched`, emit `dispatched`, then
  `intents.near.mt_transfer(merchant_id, token_id, amount, None, memo)` with 1 yocto and
  `.then(self.on_settled(op_id))`. Both use static gas with unused-gas weight 0, so they get exactly
  the measured amounts. The memo is `vault:<op_id>:<invoice_ref>`.
- `on_settled(op_id)` (`#[private]`): reads the promise result and calls `finish(op_id, Settled |
  Failed)`. It never panics.
- `finish(op_id, outcome)`: the only routine that ends a dispatched op. If the op is not in
  `active` as `Dispatched`, it changes nothing and emits `late_resolution_ignored`. Otherwise, for
  `Settled` it adds `amount` to `today` when `day` is the current day (a past day's spend no longer
  affects admission); for any outcome it moves the record from `active` to `recent` with the
  outcome and emits the event. Callbacks and `release_stuck` both go through it, so each op changes
  the budget exactly once.

Views:

- `get_config()`, `get_merchants()`, `get_op(op_id)` (active or recent), `list_ops()`,
  `budget() -> { day, daily_max, spent, reserved, remaining }` (`remaining` saturates at 0).
- `check_payment(req) -> { decision: Allow | NeedsApproval | Reject(code), remaining_after }`: a
  policy preview that assumes the configured agent is calling, uses the effective pending count, and
  writes nothing. Caller authentication exists only in `request_payment`.

## Failure cases

| Case | Outcome |
|---|---|
| `mt_transfer` fails: insufficient Intents balance (for example after a withdrawal), transfers paused, vault locked, or auth by predecessor disabled for the vault | callback: `Failed`, budget released, 1 yocto refunded to the vault |
| Callback runs out of gas or fails | op stays `Dispatched`, budget held (fails closed). After 10 min the owner may `release_stuck`; a later callback is ignored |
| Agent attaches too little gas | `InsufficientGas` before anything is stored or sent |
| Policy changes while ops are pending | awaiting ops `Rejected`; dispatched ops settle normally |
| Settlement lands after midnight UTC | charged to the day of dispatch, which no longer limits new requests |
| Merchant account locked in Intents | Intents still credits a locked account, so the payment succeeds |
| Merchant account does not exist on NEAR | Intents still credits it; not a failure path |

Known limit: the budget is per UTC day of dispatch, not a rolling 24 hours, so up to
`2 * daily_max` can be dispatched within minutes around midnight.

## Explanation shown to the owner

Built by the app from `PaymentOp`, `get_config`, `get_merchants`, `budget` and `wrap.near`
`ft_metadata` (decimals), never by the LLM. Template:

> Pay **0.50 wNEAR** to **Report Shop** (`reports.merchant.near`, allowlisted) for invoice
> **INV-42**, from vault `vault.owner.near`. Today: 1.20 spent, 0.30 pending, limit 5.00;
> 3.00 left after this. Needs your approval: above the 0.25 threshold. Expires 14:05 UTC.

Each rejection code maps to one fixed sentence. The LLM may add a note beside it, labelled as
unchecked; the contract never reads it.

The approval defence (T20) depends on the wallet showing the full `approve` arguments: contract,
method, every payment field, and the amount in base units. The day-2 gate picks a wallet that does;
if none does, the threat model narrows T20 to trusting the owner app.

## Merchant side (demo)

The merchant issues invoices `{ invoice_ref, merchant_id, token_id, amount, expires_at, delivery_token }`
and keeps them in SQLite, storing only the SHA-256 of the random delivery token. The token goes to
the buyer only, never on chain: a payment is public, so anyone who sees it knows the invoice and
transaction. `POST /deliver { invoice_ref, delivery_token, tx_hash, sender_id }` then:

1. fetches the transaction with `wait_until: FINAL` and finds a receipt **executed by
   `intents.near`** whose outcome is a success;
2. parses that receipt's NEP-245 `mt_transfer` event: `old_owner_id == vault`,
   `new_owner_id == merchant`, a single token equal to the invoice token with the invoice amount,
   and the memo exactly `vault:<op_id>:<invoice_ref>`;
3. in one SQLite transaction, checks the delivery token, marks the invoice paid and records the
   receipt as used, failing if the token is wrong or either was already used;
4. serves the report.

An event emitted by any other contract, a failed receipt, a reused payment, a second delivery
request and an observer without the delivery token are each rejected.
