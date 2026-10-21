# Architecture

Design, 21 Oct 2026, revised after the Codex design review and updated to match the build. Contract behaviour is in [payment-spec.md](payment-spec.md); this file
covers the parts around it and the app's screens.

## Parts

| Part | Path | Stack | Holds |
|---|---|---|---|
| Policy vault | `contracts/policy-vault` | Rust, near-sdk | the funds' authority; all checks |
| Agent runner | `app/agent` | Node, TypeScript, near-api-js | the agent's function-call keys (env vars), never its full-access key |
| Owner app | `app/web` | Vite, React, NEAR Wallet Selector (MyNearWallet, Intear) | nothing secret on mainnet; the owner signs in their wallet. On the local devnet only, a labelled dev signer uses the sandbox owner key and refuses any non-local RPC |
| Demo merchant | `demo/merchant` | Node, Hono, SQLite | its account id and invoices; reads chain, signs nothing |
| Security tests | `tests/security` | Rust, near-workspaces | sandbox keys only |

The agent's model call goes to NEAR AI Cloud (OpenAI-compatible API; the model is a setting, and no
claim is made about TEE inference until the chosen model's attestation is checked). A `scripted`
planner that obeys the merchant's text stands in for the model in offline demos. The model only
picks what to buy and from which merchant listing; the runner builds the `PaymentRequest` from the
merchant's invoice fields. The model's output is never the payment, and the contract checks the
payment anyway.

No indexer: the app polls the vault's views (`budget`, `list_ops`, `get_config`) every 2 s. The
only database is the merchant's SQLite of invoices and used receipts. All `U64` / `U128` values
stay strings or `bigint` in TypeScript (T25).

## Flows

```
buy:      agent -> merchant GET /offers -> POST /invoices -> {invoice}
          agent -> vault.request_payment(req) -> intents.near.mt_transfer -> vault.on_settled
          agent -> merchant POST /deliver {invoice_ref, tx_hash} -> merchant verifies the receipt -> report

approve:  vault op AwaitingApproval -> app shows explanation -> owner wallet signs approve(op)
          -> same dispatch path

deploy:   owner wallet -> one tx to vault.<owner>: CreateAccount, Transfer, DeployContract, new(...)
          app checks code hash, get_config, empty key list
fund:     owner wallet -> wrap.near.ft_transfer_call(intents.near, amount, msg = vault)
```

`POST /deliver` takes a transaction hash, not a claim. The merchant's checks (final, successful
receipt executed by `intents.near`; exact event fields and memo; invoice and receipt consumed in
one SQLite transaction) are in the spec's Merchant side section.

## Screens (owner app)

One page, four panels, plus a demo strip that only the demo build shows.

1. **Vault** (top): vault account, Intents balance, budget bar for today (spent, pending, left,
   limit), policy values with version, allowlist with labels. Owner actions open modals: edit
   policy, add or remove merchant, pause, withdraw. Each modal shows the exact call before the
   wallet opens.
2. **Approvals**: one card per `AwaitingApproval` op: the template explanation (bold amount,
   merchant label and account, invoice, budget after, expiry countdown), the LLM summary in a
   separate box labelled "Agent's note (not checked)", and Approve / Reject. Approve sends
   `approve(op)` with the stored fields, so the wallet shows the same values (if the wallet chosen
   at the day-2 gate shows full arguments). Expired cards show
   "Expired" and only Reject.
3. **Activity**: every op, newest first: time, merchant, amount, status, rejection sentence or
   explorer link. Rejected-before-storage requests are not in the contract, so this panel also
   lists the agent runner's own log of failed calls, marked "from the agent's log".
4. **Agent**: the runner's step log streamed over SSE: what it was asked, the offers, the
   merchant's raw response (injected text highlighted), the op it built, the vault's answer.
5. **Demo strip** (demo build only): buttons for the three scripted attacks, each running a
   script with its own signer: injected merchant (T1), direct call with the leaked key (T2),
   8 parallel requests from 8 keys (T5), and a tampered approval with a changed amount (T9, T20).
   The owner app never holds a key; the agent scripts run in the agent runner process.

States every panel handles: loading, empty, RPC error (keeps last data, shows "stale since
HH:MM:SS"), wallet not connected (read-only views still shown).

## Accounts on mainnet (demo)

`<name>.near` owner, `vault.<name>.near` (never any access key), `agent.<name>.near` (8
function-call keys with 0.25 NEAR allowance each; its full-access key kept offline by the owner), `shop.<name>.near` merchant, `attacker.<name>.near` for the injected
recipient. The submission's mainnet payout account is the owner account unless you choose another.

## Repo layout

```
README.md            judge path first: "do X -> see Y"
contracts/policy-vault/   (feature test-gas: underfunded callback for t17b, never in the release build)
app/agent/  app/web/
demo/merchant/
tests/security/  tests/fixtures/   (pinned intents.wasm, wrap.wasm, SOURCE.md)
docs/ architecture.md threat-model.md payment-spec.md acceptance.md
evidence/
.env.example
Makefile             build, test, test-security, check-live, fixtures, devnet, demo-local, testnet, demo-testnet
```
