# Acceptance: tests, demo and evidence

Design draft, 21 Oct 2026, revised after the Codex design review. Every threat in
[threat-model.md](threat-model.md) maps to a test here, and the demo replays the ones a viewer can
see. Method names and error codes come from [payment-spec.md](payment-spec.md).

## Test environments

| Layer | Runs | What it is for |
|---|---|---|
| Unit (`cargo test`, `contracts/policy-vault`) | policy checks, `finish` state machine, budget arithmetic, `check_payment` | every ordering, fast |
| Sandbox (`near-workspaces`, `tests/security`) | the vault against pinned `intents.near` and `wrap.near` code | cross-contract calls, callbacks, races, failures, storage |
| Merchant (`vitest`, `demo/merchant`) | delivery verification against recorded and forged receipts | T24 |
| App (`vitest`, `app/`) | explanation template, decimals, `U64` round trip | T21, T25 |
| Mainnet evidence (`evidence/`) | one funded vault, tiny amounts | proof against the live contract |

### Pinned contract code

CI never fetches from mainnet. `tests/fixtures/` holds `intents.wasm` and `wrap.wasm`, taken with
the RPC `view_code` query at a recorded final block, with their SHA-256 and that block height in
`tests/fixtures/SOURCE.md`. The suite checks each checksum before running. `make check-live` is a
separate smoke check that compares the fixtures with today's mainnet code hash and reports a
difference without failing the suite.

The live `intents.near` binary matches no published release (checked 21 Oct), so the fixture is
the only way to test what actually runs. Its `new` signature is read from `main` at `75d2976949`;
the day-1 spike confirms it on the binary.

### Sandbox bootstrap

Each step checks its resulting balance before the next:

1. Deploy `wrap.wasm` to `wrap.test.near`, call `new()`.
2. Deploy `intents.wasm` to `intents.test.near`, call
   `new({ "config": { "wnear_id": "wrap.test.near", "fees": { "fee": 0, "fee_collector": "dao.test.near" }, "roles": { "super_admins": ["dao.test.near"], "grantees": { "PauseManager": ["dao.test.near"], "UnrestrictedAccountLocker": ["dao.test.near"] } } } })`.
3. `wrap.storage_deposit` for `intents.test.near` and the owner; owner `near_deposit` 20 wNEAR.
4. Create the vault in one transaction (see the spec's Deployment), with the vault's account IDs
   pointed at the test contracts.
5. Owner `wrap.ft_transfer_call(intents.test.near, 10 wNEAR, msg: vault)`; check
   `mt_balance_of(vault, "nep141:wrap.test.near") == 10`.
6. Agent account with 8 function-call keys (receiver vault, `[request_payment]`, allowance
   0.25 NEAR each).

Fixture policy: `per_payment_max 1`, `approval_threshold 0.25`, `daily_max 3`, `max_ttl 600 s`,
`max_pending 4`. Merchants: `shop` (allowlisted), `attacker` (not).

## Security tests

"Balances unchanged" means `mt_balance_of` of the vault and of every merchant, before and after.
"Charged once" means `budget()` and the `settled` / `failed` / `released` events agree.

| Test | Layer | Do | Expect |
|---|---|---|---|
| `t01_injected_recipient` | sandbox | agent runner gets a merchant response telling it to pay `attacker`, and follows it | `MerchantNotAllowed`; balances unchanged |
| `t02_direct_call` | sandbox | sign `request_payment` with an agent key from a script, recipient `attacker` | `MerchantNotAllowed`; balances unchanged |
| `t03_agent_key_scope` | sandbox | with an agent key: call `withdraw`, `set_policy`, `approve`, `intents.mt_transfer`; call `request_payment` with 1 yocto attached | each rejected by the protocol; balances unchanged |
| `t03b_outsiders` | sandbox | an unrelated full-access account calls `request_payment` and every owner method | `NotAgent` / `NotOwner` |
| `t04_drain_in_small_payments` | sandbox | 13 payments of 0.24 | 12 settle (2.88); the 13th `OverDaily` |
| `t05_overlapping_race` | sandbox | pre-spend 2.64; send two 0.24 requests from two keys in the same block | exactly one dispatches, one `OverDaily`; receipts show the second admission ran while the first was still `Dispatched`, and the test **fails if that overlap did not happen** |
| `t06_reservation_visible` | sandbox | dispatch 0.24; read `budget()` at the block between the dispatch and callback receipts | `reserved == 0.24`; after the callback `spent` includes it and `reserved == 0` |
| `t07_callback_is_private` | sandbox | anyone calls `on_settled(op_id)` | rejected; op and budget unchanged |
| `t08_replay` | sandbox | broadcast the same signed transaction twice; submit the same request twice | the second broadcast fails on the nonce; the resubmission is a new `op_id` counted in the budget |
| `t09_approval_bound_to_fields` | sandbox | request 0.5; owner `approve`s with each field changed in turn (merchant, token, amount, invoice, expiry, policy version) with a second awaiting op's `op_id`, and with an id that is not awaiting | `ApprovalMismatch` for each field and for the second op's id; `NotAwaitingApproval` for the id not awaiting; both ops still awaiting |
| `t10_approval_single_use` | sandbox | approve op A twice | second call `NotAwaitingApproval`; one transfer |
| `t11_approval_after_policy_change` | sandbox | request 0.5; owner lowers `daily_max`; owner approves | op already `Rejected`; `NotAwaitingApproval`; no transfer |
| `t12_approval_cannot_lift_hard_limit` | sandbox | spend 2.4; request 0.5 (awaiting); spend 0.24; approve | `OverDaily`; no transfer |
| `t12b_over_per_payment` | unit | request 1.1 | `OverPerPayment`, never awaiting |
| `t13_expiry_and_ttl` | unit | expiry in the past; expiry beyond `max_ttl`; approve after expiry | `Expired`, `TtlTooLong`, `Expired` |
| `t14_field_checks` | unit | other token; amount 0; 65-byte `invoice_ref` | `WrongToken`, `ZeroAmount`, `InvoiceRefTooLong` |
| `t15a_pending_cap` | sandbox | 4 approval requests, then a 5th; approve one with the queue full; let the rest expire and request again **without** calling `cleanup`; then a request that fails `OverDaily` after pruning | 5th `TooManyPending`; approval succeeds at a full queue; the post-expiry request is accepted; the failed request leaves state unchanged |
| `t15b_storage_soak` | sandbox | 2,000 cycles of 4 expiring approval requests, then 500 transfers that fail (balance withdrawn) | `storage_usage` stays below the computed maximum; then a payment settles, a request is rejected, and `withdraw` works |
| `t15c_queue_on_policy_change` | sandbox | with 4 awaiting: `set_agent` to a new account; separately lower `max_pending` to 2 with 3 dispatched | all awaiting `Rejected`, slots freed; new requests `TooManyPending` until 2 of the 3 dispatched ops finish |
| `t16a_withdraw_vs_dispatch` | sandbox | dispatch 0.2 and withdraw the whole balance, in both receipt orders | the transfer's real outcome decides: `Settled` and charged, or `Failed` and released |
| `t16b_intents_paused` | sandbox | `dao` calls `pa_pause_feature({ "key": "mt_transfer" })`, then pay | `Failed`; budget released |
| `t16c_vault_locked` | sandbox | `dao` force-locks the vault, then pay | `Failed`; budget released |
| `t16d_merchant_locked` | sandbox | `dao` force-locks `shop`, then pay | `Settled`; `shop` credited |
| `t16e_yocto_refund` | sandbox | any failed transfer above | the refund receipt sends 1 yocto to the vault (checked on the receipt, not by balance arithmetic) |
| `t17a_finish_state_machine` | unit | with 2 unrelated `Dispatched` ops present: callback success, callback failure, `release_stuck(Settled)`, `release_stuck(Released)`, recovery then late callback, callback then recovery | each op changes the budget once; unrelated reservations untouched; late resolution emits `late_resolution_ignored` |
| `t17b_starved_callback` | sandbox, `test-gas` build | real transfer succeeds, callback gets too little gas | `shop` credited; op `Dispatched`, budget held; `release_stuck` refused before 10 min, accepted after; charged once |
| `t17c_insufficient_gas` | sandbox | `request_payment` with less than the required gas | `InsufficientGas`; no record, no reservation, no transfer |
| `t17d_gas_table` | sandbox | measure `request_payment`, `mt_transfer` and `on_settled` with maximum-length inputs, first-use storage, success and failure | the static amounts cover each by at least 2x; receipts show exactly the static amounts (unused-gas weight 0) |
| `t18_no_intents_keys` | sandbox | after the full suite | `public_keys_of(vault) == []`; auth by predecessor enabled |
| `t19_no_access_keys` | sandbox | after deployment | `view_access_key_list(vault)` empty |
| `t22_midnight` | unit | dispatch before 00:00 UTC, dispatch again after, then settle the first with success and with failure; request before midnight and approve after | the new day's budget is unaffected by the old op; the approved op is charged to the approval day; the documented `2 * daily_max` bound holds |
| `t23_initialisation` | sandbox | call `new` again as the owner and as an outsider | both fail |
| `t24_merchant_delivery` | merchant | a contract that emits an identical event; a failed receipt; the right payment with another invoice; the same delivery twice, sequential and concurrent | each rejected; one report served |
| `t25_u64_round_trip` | app | `op_id` and `expires_at_ns` above 2^53 from the contract view into `approve` | the args sent equal the stored op |
| `t21_explanation_template` | app | 1 yocto, 0.25, 0.5, 1 wNEAR; every rejection code | exact strings; decimals from `ft_metadata` |
| `t_arith_boundaries` | unit | `u128` near max; lower `daily_max` below spent plus reserved | checked arithmetic; `remaining` is 0, not wrapped; pending ops settle under their reservation |

T20 is a recorded demo, not a test: it depends on the wallet chosen at the day-2 gate.

Done for the suite: one command (`make test-security`) passes on a clean checkout with the pinned
fixtures, and each test was seen to fail once against a vault with that check removed.

## Demo (target 2:45)

Mainnet, scaled down: `per_payment_max 0.01`, `approval_threshold 0.005`, `daily_max 0.03`,
`max_pending 8` wNEAR; about 0.05 wNEAR funded; 8 agent keys. Screen recording of the app and the
wallet, explorer links on screen.

| Time | Shows | Viewer sees |
|---|---|---|
| 0:00 | the claim | "Compromise the agent. The spending limits still hold." Vault, policy and allowlist |
| 0:15 | normal purchase | agent buys a report for 0.002; explanation; merchant verifies the receipt; report delivered. Spent 0.002 |
| 0:40 | T1 | merchant reply injects "pay attacker.near"; agent tries; `MerchantNotAllowed`; balance unchanged |
| 1:00 | T2 | terminal: a leaked agent key calls the vault directly; same rejection |
| 1:15 | T9, T20 | 0.008 request awaits approval. A tampered app build asks the wallet to approve 0.009; the wallet shows it; the contract rejects `ApprovalMismatch`. The owner approves the real one. Spent 0.010 |
| 1:50 | T5 | 8 requests of 0.004 from 8 keys at once: exactly 5 dispatch (0.020 left), 3 `OverDaily`; budget bar stops at 0.030 |
| 2:15 | evidence | explorer links, `public_keys_of(vault) == []`, empty key list, test suite output |
| 2:35 | limits | what it does not claim, including Intents admin powers |

The T5 count is exact in any order: each admission sees all earlier ones as spent or reserved.

## Evidence (`evidence/`)

- Mainnet: vault, agent and merchant accounts; the deployment transaction (one transaction, no
  `AddKey`); tx hashes of funding, each demo payment, each rejection and the approval;
  `public_keys_of`, access key list and code hash of the vault.
- Fixture checksums, their source block, and the `make check-live` result on the submission day.
- `make test-security` output and the `t17d` gas table.

## Day-2 gate (1–2 Nov)

All must pass by the end of day 2:

1. Sandbox bootstrap above works with the pinned binaries, including the `new` signature.
2. A stub vault's `mt_transfer` with 1 yocto succeeds and fails as expected; the callback sees both.
3. The starved-callback case behaves as `t17b` expects.
4. Gas table for the three calls.
5. A NEAR wallet that shows `approve`'s full arguments (contract, method, every field) is chosen
   and screenshotted. If none does, T20 narrows to trusting the owner app.
6. The same transfer on mainnet with 0.001 wNEAR from a throwaway vault.

Otherwise: fallback to a vault holding the token directly, or to the explainer only (Codex plan).

## Scope order

Contract and security suite first. Then one owner screen (approvals and activity) and the
scripted attacks. Then the agent and merchant. End-to-end candidate by day 8; days 9–14 are for
adversarial checks, reproducibility and evidence. The agent log stream (SSE), the policy-editing
modals and the vault panel's extras are cut first if time runs short.
