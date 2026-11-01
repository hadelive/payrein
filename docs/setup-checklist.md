# Setup checklist for the hackathon run

What the owner prepares before the November run, in order, with where each secret lives and a
check after each step. Commands were checked against this repository's scripts on 25 October 2026
and against the tool docs named in each step; anything not checked end to end is marked
**unverified** so you can confirm it as you go.

Secrets never go into a terminal command line, a chat window, or git. They live in:

| Secret | Where | Read by |
|---|---|---|
| Testnet owner key | `~/.near-credentials/testnet/<you>.testnet.json` (mode 600) | `make testnet`, `pnpm --filter @vault/agent e2e testnet` |
| NEAR AI Cloud key and model | `.env` at the repo root (git-ignored) | `scripts/demo-local.sh`, which exports only `PLANNER`, `NEARAI_URL`, `NEARAI_API_KEY`, `NEARAI_MODEL` |
| Wallet seed phrase or key | the wallet only | you, when approving |
| Mainnet prize account | the submission form | the organisers |

## 1. A funded testnet account and its key file

The testnet bootstrap (`tests/security/examples/testnet.rs`) needs one account, `<you>.testnet`,
with at least 18.5 NEAR, and its full-access key in near-cli's legacy keychain file. It creates
`intents.`, `agent.`, `shop.`, `attacker.` and `vault.` under that account, so the name must be
fresh: none of those five may exist yet.

First install the README's prerequisites, since `make testnet` builds the contract: Rust 1.93+
with `rustup target add wasm32-unknown-unknown`, `cargo install cargo-near --version 0.22.0 --locked`,
Node 22.13+, pnpm 11 and Python 3. Run every command below from the repository root.

Install near-cli-rs (docs: https://docs.near.org/tools/near-cli):

```sh
npm install -g near-cli-rs@latest
near --version
```

Create the account through the faucet, saving the key to the legacy keychain. Pick a name nobody
has used; the command fails if it is taken. Set `umask 077` first so both files near-cli-rs
writes are private from the start.

```sh
umask 077
near account create-account sponsor-by-faucet-service <you>.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

This writes `~/.near-credentials/testnet/<you>.testnet.json` and a second copy under
`~/.near-credentials/testnet/<you>.testnet/<public-key>.json`, each with `public_key`,
`private_key` and the master seed phrase (near-cli-rs source, `KeyPairProperties`; it writes no
`account_id`, which the bootstrap tolerates). The seed phrase is what you import into the wallet
in step 2.

**Verify:**

```sh
near account view-account-summary <you>.testnet network-config testnet now
near account list-keys <you>.testnet network-config testnet now
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["public_key"])' \
  ~/.near-credentials/testnet/<you>.testnet.json
ls -l ~/.near-credentials/testnet/<you>.testnet.json ~/.near-credentials/testnet/<you>.testnet/
```

The summary shows the account and its balance. The key list must contain the `public_key` the
third command printed, with **full access** (the bootstrap refuses a function-call key). Both
credential files must be `-rw-------`; `chmod 600` any that are not.

**Faucet amount, unverified.** The NEAR docs say the faucet sends "a small amount" without a figure
(https://docs.near.org/getting-started/faucet); community notes say about 10 NEAR per account, and
the faucet may rate-limit repeated requests. The bootstrap refuses to spend anything below 18.5 NEAR,
so if the summary shows less, create a second faucet account, read its balance from its own summary,
and move all but about 0.5 NEAR across (adjust the amount to what it actually holds):

```sh
near account create-account sponsor-by-faucet-service <you>-2.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near tokens <you>-2.testnet send-near <you>.testnet '9.5 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

Repeat with a third account if needed, waiting out any rate limit the faucet reports.
`sign-with-legacy-keychain` signs with the file that `save-to-legacy-keychain` wrote (confirmed in
the near-cli-rs source; `near tokens <you>-2.testnet send-near <you>.testnet '1 NEAR'
network-config testnet --help` lists the signing options). An alternative is https://near-faucet.io,
which lets you choose the amount (external site, **unverified**).

**Verify:** the summary for `<you>.testnet` shows at least 18.5 NEAR, and none of the five
sub-accounts exist:

```sh
for a in intents agent shop attacker vault; do
  near account view-account-summary $a.<you>.testnet network-config testnet now
done
```

Each must fail with an explicit account-does-not-exist error; a network or RPC error proves
nothing, so retry it. The bootstrap also treats any query error as absence, which is why this
manual check matters.

## 2. A testnet wallet signed in as that account, and the T20 check

The owner app's wallet selector offers MyNearWallet and Intear (`app/web/src/signer.ts`). The
approval step only protects you if the wallet shows every argument of the `approve` call
(threat model T20), so the wallet choice is part of the security check, not a convenience.

**Intear** (https://wallet.intear.tech, source https://github.com/INTEARnear/wallet): its sign
screen shows the method name, gas and deposit, plus an expandable section with the full `args` as
pretty-printed JSON, and it can import an account from a seed phrase or a private key
(DeepWiki reading of `web/src/pages/send_transactions.rs` and `web/src/components/login_form.rs`,
**not yet confirmed by hand**). Import `<you>.testnet` there with the seed phrase from step 1.

**MyNearWallet** (https://testnet.mynearwallet.com): import via "Import existing account". Whether
its confirmation screen expands the arguments is **unverified**; check it the same way below.

**Verify (the T20 check), after step 3 and `make testnet` have run and `make demo-testnet` is up:**

1. In the owner app, click **4 Buy (needs approval)**. An approval card appears.
2. Open **Exact call your wallet will show** on the card and keep it visible.
3. Click **Approve**. The wallet opens its confirmation screen.
4. In the wallet, check the envelope first: signer `<you>.testnet`, receiver `vault.<you>.testnet`,
   exactly one action, method `approve`, deposit 1 yoctoNEAR, gas 100 Tgas (what the app sends,
   `app/web/src/signer.ts`). Then expand the arguments and compare every field of `op` with the
   card's exact call: `op_id`, `merchant_id`, `token_id`, `amount`, `invoice_ref`,
   `expires_at_ns`, `policy_version`. The amount is in base units (0.008 wNEAR is
   `8000000000000000000000`).
5. If the wallet shows only the method name and not the fields, reject, and use the other wallet.
   Record which wallet passed, with a screenshot, in `evidence/`.

Keep the wallet on **testnet** when you create the vault (step 1's account) and when you approve.

## 3. NEAR AI Cloud key and model

The agent's planner calls NEAR AI Cloud's OpenAI-compatible endpoint
(`app/agent/src/planner.ts`; base URL `https://cloud-api.near.ai/v1`, docs
https://docs.near.ai/cloud/quickstart). The launcher requires `NEARAI_API_KEY` and `NEARAI_MODEL`
whenever `PLANNER=nearai` (`scripts/demo-local.sh`).

1. Create an account at https://cloud.near.ai, add credits, and generate a key in the dashboard's
   API Keys section (the docs point at https://cloud.near.ai/dashboard/organizations). Copy it
   straight into the file below, never into a terminal or a chat.
2. Create `.env` at the repository root (it is listed in `.gitignore`) with exactly these lines,
   using an editor:

   ```
   PLANNER=nearai
   NEARAI_API_KEY=<paste the key>
   NEARAI_MODEL=<a model id from the list below>
   ```

   Then `chmod 600 .env`. The launcher reads only these keys (and `NEARAI_URL`) from the file,
   so nothing else in it can override the demo's generated settings.
3. Pick the model id from the live list rather than from memory; ids change:

   ```sh
   sed -n 's/^NEARAI_API_KEY=/Authorization: Bearer /p' .env |
     curl -fsS -H @- https://cloud-api.near.ai/v1/models | python3 -m json.tool | grep '"id"'
   ```

   The header goes in through stdin, so the key never appears in a command line or in `ps`.

   The quickstart's example id at the time of writing was `zai-org/GLM-5.1-FP8` (**unverified**;
   ids change). Pick a chat model that the live list shows, and write it into `.env`.

**Verify:**

```sh
git check-ignore .env                           # prints .env: it will not be committed
ls -l .env                                      # -rw-------
sed -n 's/^NEARAI_API_KEY=/Authorization: Bearer /p' .env |
  curl -fsS -o /dev/null -w '%{http_code}\n' -H @- https://cloud-api.near.ai/v1/models   # 200
```

A 401 means the key was rejected; a 200 proves the key, not that the model answers or that credits
remain. The proof is one purchase that goes all the way through with the model: with the demo
running, click **1 Buy a report**, then check that the run's `task` step names the planner, a
`model` step chose an offer, and a `deliver` step follows with no `error` step
(`app/agent/src/agent.ts` logs the planner before calling it, so the name alone is not enough):

```sh
curl -s http://127.0.0.1:8788/log | python3 -c 'import json,sys; s=json.load(sys.stdin)["steps"]; r=s[-1]["run"]; print([(x["kind"], x["text"][:40]) for x in s if x["run"]==r])'
```

The planner name should read `nearai:<model>` in the task step's data.

## 4. The testnet deployment and the demo

With steps 1 and 3 done (the key file in place, `.env` written):

```sh
pnpm install
TESTNET_ACCOUNT=<you>.testnet make testnet     # spends about 18.5 NEAR, writes target/testnet.json
make demo-testnet                              # merchant, agent and owner app on http://127.0.0.1:5173
```

`make testnet` checks the chain id, that the key file's key is a full-access key on the account,
the balance and the five free names before it sends anything, so a preflight refusal costs
nothing. A failure after that point can leave funded sub-accounts behind, and a rerun is not
resumable: it will refuse because the names exist, so use a fresh root name.

The bootstrap talks to `https://test.rpc.fastnear.com` (hard-coded in `testnet.rs`) and the demo's
services inherit it through `target/testnet.json`; near-cli-rs uses its own `testnet` connection and
the wallet its own. `.env` does not change any of these.

**Verify:** the last line of `make testnet` prints `testnet ready` with the vault id and a
testnet.nearblocks.io link. Then:

```sh
python3 -c 'import json; d=json.load(open("target/testnet.json")); print(d["vault_id"], d["intents_id"], d["owner_id"])'
near account list-keys vault.<you>.testnet network-config testnet now   # no keys at all
```

The owner app shows the testnet badge and the vault balance of 0.1 wNEAR. The daily budget resets
at 00:00 UTC, so keep a rehearsal and the recorded take in separate UTC days, or run the
rehearsal with the budget's remainder in mind.

Optional, the same checks scripted (signs approvals with your key file, no wallet). Keep
`make demo-testnet` running in another terminal; the script needs the agent on :8788 and refuses
to start unless today's budget is untouched (zero spent, zero reserved). A run spends the whole
0.030 daily budget, so run it before any manual purchase or on a later UTC day, and never while
the wallet is signing with the same owner key. The vault starts with 0.1 wNEAR, so three full runs
leave 0.010.

```sh
pnpm --filter @vault/agent e2e testnet
```

It prints `ok` for each of its checks and the transaction links.

## 5. The mainnet prize account

The form asks for a NEAR wallet address where the prize is sent, in NEAR, and the organisers'
notes say a mainnet account: a named account such as `you.near` or a 64-character implicit account
(https://nearhackathon.com/HACKATHON.md). Any mainnet account you control is enough; it does not
have to be the vault owner. Do not reuse the testnet account name as if it existed on mainnet.

**Verify:**

```sh
near account view-account-summary <you>.near network-config mainnet now
```

It must print the account's summary, not "does not exist".

## 6. The X account and the demo post

The submission needs a public X post that says the project was built at NEAR HACKATHON, with the
demo video or screenshots attached, and the form takes the post's link (homepage, Final Submission
section). The draft post, the repository link reply and the 2:55 video script are in
[submission.md](submission.md).

- The X account must be public and the post must stay up through judging (16 to 18 November).
- Post only inside the window (1 to 14 November UTC) and only after the repository is public, since
  the reply links to it.
- Attach the video directly rather than linking a host; screenshots are the fallback.

**Verify:** open the post's URL in a private browser window with no X login. The text and the video
must load. Paste that URL into the form.

## 7. Eligibility, and the form's traps

No message to the organisers is needed. Their FAQ (https://nearhackathon.com/HACKATHON.md, Q-001,
read on 1 November 2026) says code written since the announcement on 19 October 2026 counts and
earlier commits are baseline. This repository started on 21 October, so all of it is inside the
counted period; the README's "Eligibility" line says so.

Three rules from the same file to carry into the form:

- The submission cannot be edited and each repository can be sent once. Send it last, after the
  repository is public and the post is up.
- The form's "Website" field is a spam trap: "any non-empty value rejects the submission". Leave it
  empty and put the landing page's URL in the description text instead.
- Screenshots alone are not enough when judges cannot open the demo (Q-012), so attach a video. A
  hosted demo is a plus; keep it up to 18 November, ideally 25 November.

**Verify:** re-read https://nearhackathon.com/HACKATHON.md on submission day; it says dates and
rules may change.

## Before the recorded take

- Step 2's wallet check passed, with its screenshot in `evidence/`.
- One model-driven purchase delivered (step 3's check), on a previous UTC day or with the budget
  accounted for.
- `make demo-testnet` is up, the wallet is signed in as `<you>.testnet`, and today's budget is
  untouched (the budget bar reads 0 spent).
- The whole take fits in one UTC day.
