# Local evidence (21–22 Oct 2026)

All runs on macOS, Rust 1.97.1, cargo-near 0.22.0, Node 22.21, against the pinned mainnet binaries
in `tests/fixtures/` (mainnet block 220928157; `intents.near` code hash
`BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, the live mainnet code on that day).

## Test suites

| Suite | Command | Result |
|---|---|---|
| Contract unit tests | `cargo test -p policy-vault` | 27 passed |
| Sandbox attack tests | `make test-security` | `security` 25 passed, `spike` 2 passed |
| Mutation check | `python3 -I scripts/mutation-check.py` | 5 of 5 mutants caught (below); each covering test passes on the real contract first and must then fail on an assertion, not a build error |
| Merchant | `pnpm --filter @vault/merchant test` | 18 passed |
| Agent runner | `pnpm --filter @vault/agent test` | 20 passed |
| Owner app | `pnpm --filter @vault/web test` | 17 passed |
| End to end on the local devnet | `pnpm --filter @vault/agent e2e devnet` | all 11 checks passed (below) |

## Mutation check

Each line removes one check from the contract, rebuilds, and runs the tests that cover it.

| Mutant | Caught by |
|---|---|
| allowlist removed | `t01_unlisted_merchant_rejected`, `t01_t02_unlisted_recipient_rejected` |
| daily limit removed | `t04_*`, `t12_*` (unit and sandbox) |
| reservations not counted | `t05_t06_*` (unit and sandbox) |
| approval not bound to fields | `t09_*` (unit and sandbox) |
| finished op stays active (would double-count) | `t17a_finish_acts_once_in_every_order` |

Dropping only the status guard in `finish` is an equivalent mutant: only dispatched ops ever get a
callback, and a finished op has already left the active list.

## Measurements

| Item | Value | Source |
|---|---|---|
| Gas burnt with state at its bounds (32 merchants, full recent ring, awaiting ops to scan, 64-byte invoice): `request_payment` | 2.82 Tgas | `t17d_gas_table` |
| Same: `mt_transfer` on `intents.near` | 3.73 Tgas; receipt carries exactly 15 Tgas | `t17d_gas_table` |
| Same: `on_settled` callback | 2.00 Tgas; receipt carries exactly 10 Tgas | `t17d_gas_table` |
| Vault storage after 15 and after 30 soak cycles (4 expiring requests and 1 failed transfer each) | 219,277 bytes both times | `t15b_storage_soak` |
| Overlap in the race test | the refused request executed in an earlier block than the winner's settlement callback | `t05_t06_*` asserts it |
| Refund of the 1 yocto after a failed transfer | `mt_transfer` carries a deposit of exactly 1; the runtime's refund receipt from `system` to the vault is a `Transfer` of exactly 1 | `t16e_*` (receipt actions via `EXPERIMENTAL_tx_status`) |
| Locked merchant | still credited (Intents credits locked accounts) | `t16d_*` |
| Withdrawal racing a payment | exactly one of the two transfers moves funds; budget follows the payment's real outcome | `t16a_*` |

## End-to-end run on the local devnet

`make demo-local`, then `pnpm --filter @vault/agent e2e devnet` (demo policy: per payment 0.01,
approval above 0.005, daily 0.03 wNEAR):

```
ok   normal purchase paid 0.002 and the report was delivered
ok   T1 injected recipient refused: MerchantNotAllowed
ok   attacker received nothing
ok   T2 direct call refused: MerchantNotAllowed
ok   T9 tampered approval refused: ApprovalMismatch
ok   approved payment of 0.008 delivered
ok   0.020 of the 0.030 daily budget left
ok   T5 parallel: 5 accepted, 3 refused
ok   the 3 refusals are OverDaily
ok   budget stops at the limit: spent 0.03
ok   merchant received exactly 0.030 in total
all demo steps passed
```

The same sequence was clicked through in the owner app in Chrome, with no console errors, plus
Pause and Unpause from the app. The agent runner refused requests without its token (401).

Rerun on 22 Oct after the owner app's layout change (summary first, seven numbered demo steps,
explicit network): all 11 checks passed again. The app after that run:
[owner-app-after-demo.png](owner-app-after-demo.png) (headless Chrome, 1280 px wide).

## Not yet done

- Testnet deployment (`make testnet`) and its transaction evidence.
- Mainnet deployment and its transaction evidence.
- A wallet that shows `approve`'s full arguments (T20), confirmed with a screenshot.
- A run with a real model (`PLANNER=nearai`).
