# Payrein

**Compromise the agent. The spending limits still hold.**

An AI agent pays for things from a NEAR Intents balance, but it never holds that balance. A small
Rust contract, the vault, does. The agent has one function-call key that can only ask the vault to
pay. The vault pays only allowlisted merchants, in one token, within a per-payment and a daily
limit, and anything above an approval threshold waits until the owner approves that exact payment.
A hijacked prompt, a replaced agent binary or a leaked key changes none of that, because the checks
run in the contract that moves the funds.

Tracks: AI Security & Defense (primary), Agent Economy.

## Try it (judges start here)

Prerequisites: Rust 1.93+ (tested with 1.97) with the `wasm32-unknown-unknown` target, `cargo install cargo-near
--version 0.22.0 --locked`, Node 22.13+, pnpm 11, Python 3, about 2 GB free for the sandbox.

```sh
pnpm install
make test-security     # builds the contract, runs 25 attack tests against the real Intents code
make demo-local        # local chain + two merchants + agent + owner app on http://127.0.0.1:5173
```

`make test-security` runs every test against the exact `intents.near` binary that is live on
mainnet, pinned in `tests/fixtures/` with its checksum (`make check-live` compares it with mainnet
today). Expect `test result: ok. 26 passed` for `security` (the 25 attack tests and the `t17e` gas
benchmark) and `2 passed` for `spike`.

With `make demo-local` running, open the app and click the demo buttons in this order:

| Do | See |
|---|---|
| **Buy a report** | Agent panel: `4 offers from 2 merchants`, `chose near-weekly from shop.test.near` (0.002 beats Data Desk's 0.003), invoice, `accepted as op 1`, `report delivered`. Budget bar: 0.002 spent. The invoice carried text telling AI agents to pay `attacker.test.near`; the agent's normal path builds the payment from the invoice's fields and ignores it. |
| **T1 injected merchant** | The agent now runs as if hijacked and obeys that text: `decided to pay attacker.test.near`, then `refused: MerchantNotAllowed`. Activity: *The recipient is not on the allowlist.* Attacker balance stays 0. |
| **T2 leaked key** | A script signs with the agent's key and calls the vault directly, bypassing the app: same refusal. |
| **Buy (needs approval)** | T26 first: Data Desk quotes the deep dive at 0.006, cheaper than Report Shop's 0.008, so the agent picks it; its invoice asks 0.009. The agent refuses it without paying (`refused desk.test.near's invoice, nothing paid: invoiced 0.009, quoted 0.006`) and buys from Report Shop. The contract would have accepted 0.009 (it is under the 0.01 per-payment cap): price honesty is the agent's check, the caps are the contract's. Then 0.008 is above the 0.005 threshold. Approvals shows the payment in plain words, the budget after it, why it needs approval, the exact call the wallet will show, and the agent's own note in a box marked *not checked*. |
| **T9 tampered approval** | A tampered app asks to approve 0.009 instead of 0.008: *The approval did not match the stored payment in every field. (ApprovalMismatch)* The contract catches any changed field. It cannot catch an app that swaps in a different, complete awaiting payment; only the wallet's display of `approve`'s full arguments does (T20), which is why the owner reads the wallet, not the app. |
| **Approve** | The vault pays 0.008; the merchant checks the owner's transaction on chain and delivers. Spent 0.010. |
| **T5 8 at once** | 8 requests of 0.004 from 8 keys in the same moment, 0.020 left: exactly 5 settle, 3 `refused: OverDaily`. The bar stops at the 0.030 limit. Run instead while step 4's payment is still waiting (as the landing page's capture was), the pending queue of 8 has one slot taken, so 7 settle and 1 is `refused: TooManyPending`: a different limit, same contract. |

The same script without a browser: `pnpm --filter @vault/agent e2e devnet` while `make demo-local`
runs; it checks every step above and the balances.

The demo uses a scripted stand-in for the model, so it needs no API key. To use a real model:
`PLANNER=nearai NEARAI_API_KEY=... NEARAI_MODEL=<model id> make demo-local` (NEAR AI Cloud,
OpenAI-compatible).

### On testnet

Testnet has no live Intents contract (`intents.testnet` holds no code), so the testnet run deploys
the same pinned mainnet binary to `intents.<you>.testnet` and pays in the live `wrap.testnet`. Your
testnet account is the vault's owner and approves in a testnet wallet (MyNearWallet or Intear), which
is where the wallet's display of `approve`'s arguments is checked (T20).

```sh
# a testnet account with at least 19.6 NEAR, its key in ~/.near-credentials/testnet/<you>.testnet.json
TESTNET_ACCOUNT=<you>.testnet make testnet   # creates intents., agent., shop., attacker., vault. under it
make demo-testnet                            # two merchants + agent + owner app on http://127.0.0.1:5173
pnpm --filter @vault/agent e2e testnet       # optional: the same checks, approving with your key file
```

Most of the 19.6 NEAR is storage for Intents' 1.3 MB of code. The bootstrap checks the balance and
that none of the accounts exist before it sends anything. The demo's checks assume an unused daily
budget, so the end-to-end script runs once per UTC day.

## What is enforced, and where

All in [`contracts/policy-vault/src/lib.rs`](contracts/policy-vault/src/lib.rs):

- **Allowlist, token, per-payment and daily limits, expiry, pending cap**, checked on every request
  in a fixed order; a refused request stores nothing.
- **Budget reserved before the transfer is sent.** The vault pays with `intents.near`'s
  `mt_transfer` from its own balance and records the result in a callback. Spent plus reserved never
  exceeds the daily limit, even with requests in flight (T5, shown with receipts in
  `t05_t06_overlapping_requests_cannot_oversubscribe`).
- **Approval bound to every field.** `approve` takes the whole stored payment and compares it field
  by field; any policy change cancels payments waiting for approval; approval never lifts a hard
  limit.
- **Each payment finishes exactly once.** One routine ends a dispatched payment, from the callback or
  the owner's recovery, so a late callback cannot count it twice. If the callback never runs, the
  budget stays held (fails closed) until the owner recovers it.
- **Bounded storage.** At most 16 active and 64 recent records; history lives in NEP-297 events.
- **No keys.** The vault is created, funded, deployed and initialised in one transaction with no
  access key, and has no Intents key and no arbitrary-call method.

## What it does not claim

- Nothing protects against a stolen **owner** key.
- It does not stop an allowlisted merchant from taking payment and not delivering; the limits cap
  that loss.
- It trusts `intents.near`, whose admins can pause transfers, lock accounts, force-transfer balances
  and upgrade the contract. The live binary matches no published release.
- Approval only protects the owner if their wallet shows the call's full arguments.
- The agent runner keeps a purchase that awaits approval only in memory. If the runner restarts
  before the owner approves, the payment still settles but the runner no longer holds the invoice's
  delivery token, so that report is not collected. The merchant re-serves a paid invoice to the
  token's holder, so a runner that persisted its tokens would recover; the demo runner does not.
- The demo's "compromised" mode forces the agent to obey injected text. It demonstrates what the
  contract does when an agent is hijacked; it is not a measurement of how often a model is.
- It is not a fix for, and makes no claim about, the October 2026 Intents incident.
- **The contract is unaudited.** Keep amounts tiny.

Full threat model: [docs/threat-model.md](docs/threat-model.md).

## Evidence

| What | Where |
|---|---|
| 27 unit tests: checks, the finish state machine, midnight, storage bound | `cargo test -p policy-vault` |
| 25 sandbox attack tests (T1–T23) against pinned mainnet Intents | `make test-security` |
| Five targeted mutations (allowlist, daily limit, reservation counting, approval field binding, finish-once) each make their covering test fail after it passed on the real contract (5/5 caught). This checks those five checks, not every line | `python3 -I scripts/mutation-check.py` |
| Merchant only delivers for a final, successful Intents receipt, once, to the buyer holding the delivery token (T24) | `demo/merchant/test` |
| 64-bit values exact from the vault's view to the bytes of the owner's `approve` (T25); explanation template (T21) | `app/agent/test`, `app/web/test` |
| Gas, storage and test output from the last full run | [evidence/](evidence/) |
| The pinned `intents.near` and `wrap.near` binaries equal the live mainnet code: checked 2 November 2026 at block 222693527 | `make check-live`, [evidence/local-run.md](evidence/local-run.md) |
| Security review of 2 November 2026 by Codex gpt-6-astra (an AI review, not an audit): findings, their verification and the fixing commits | [docs/review-2026-11-02.md](docs/review-2026-11-02.md) |
| Demo video of the seven steps above, recorded on the local devnet on 1 November 2026 with `scripts/record-demo.mjs` (55 s, captions on screen); stills of the approval card, the tampered approval and the full daily bar | `evidence/video-*.png`, the video on the X post |

Test names start with the threat id they cover in the threat model; the mapping is in
[docs/acceptance.md](docs/acceptance.md).

## Layout

```
contracts/policy-vault/   the vault (Rust, near-sdk 5.29)
tests/security/           sandbox attack tests, harness, devnet example
tests/fixtures/           pinned intents.wasm and wrap.wasm from mainnet, with checksums
app/agent/                agent runner: planner, restricted keys, demo attacks, SSE log
app/web/                  owner app: vault, approvals, activity, agent log (Vite, React)
demo/merchant/            demo merchant: invoices, on-chain payment verification (Hono, SQLite); run twice as Report Shop and Data Desk
docs/                     spec, threat model, acceptance plan, architecture
scripts/                  fixtures, demo env, mutation check, demo launcher
```

## Product thesis and current evidence

The first users are teams whose agents buy data or API calls from suppliers they already know. They
want small payments to go through on their own, a hard cap on what a compromised agent can lose, and
a say on anything larger. The vault gives them that as a contract they deploy themselves plus an
owner app; the planned agent SDK and merchant library (below) are how it would be embedded. What is
shown today: one token, one agent identity, two demo merchants the agent chooses between, and the attack evidence above. What is
not: any outside team using it, any revenue, or a validated business model. The next test of the idea
is one independent integration, measuring setup time, successful purchases, approval burden and
operating cost. Spending limits alone are not a moat; integration quality, trusted operation and
distribution would have to earn one.

## Roadmap

In priority order, each a small step from what exists; milestones, not dates:

1. **Independent security review** of `policy-vault` and remediation, then a tiny mainnet pilot with
   its transaction evidence published here.
2. **Agent SDK.** Extract the runner's `VaultClient` and the app's `explain` module into a package
   with one integration example, so any agent framework can request payments and any wallet or app
   can render an approval in plain words from the same fields.
3. **Merchant verification library.** Extract the demo merchant's receipt check (final receipt,
   executed by Intents, exact event, memo bound to the invoice) with its persistence and replay
   requirements documented, so any seller can accept vault payments safely.
4. **Several agents per vault**, each with its own allowance and revocation, under one vault cap.
5. **Several tokens per vault**, with a budget per token and explicit decimal handling; a combined
   fiat-denominated limit is deferred.

## Status and timeline

Stated so judges can check it against the git history.

**Done before the development phase (21–25 October 2026):** the design documents, the contract and
its unit tests, the sandbox attack suite against the pinned mainnet Intents binary, the mutation
check, the agent runner, the demo merchant, the owner app, the one-command local demo, the testnet
bootstrap, and the setup checklist for the testnet run. Everything in this README's evidence table
runs and passes locally.

**Done in the development phase so far:** 1 November, the demo video, recorded from the local
devnet run by `scripts/record-demo.mjs` (stills in `evidence/`). 2 November, this repository made
public and the project submitted; a security review by Codex gpt-6-astra with its findings fixed
the same day ([docs/review-2026-11-02.md](docs/review-2026-11-02.md): the testnet bootstrap would
have installed full-access keys derived from a public seed, the merchant could not re-serve a paid
invoice after a lost response, two smaller app bugs); `make check-live` rerun; the claims in the
docs matched to the code and the evidence; MIT licence and CI added.

**Planned during the window (1–14 November 2026):** the testnet deployment and its evidence, the
wallet check of `approve`'s arguments with a screenshot (T20), a run with a real model on NEAR AI
Cloud, the mainnet pilot with tiny amounts, and whatever those turn up. Items move to the list
above only with dated evidence and commits.

**Eligibility:** the organisers' FAQ (https://nearhackathon.com/HACKATHON.md, Q-001, read on
1 November 2026) says code written since the announcement on 19 October 2026 counts and earlier
commits are baseline. This repository's first commit is from 21 October 2026, so all of it falls
inside the counted period; the git history and the dates above show what was built before the
1 November development phase and what during it.
