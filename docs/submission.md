# Submission kit

**Submitted on 2 November 2026** through the form at https://nearhackathon.com/#apply: project Payrein, solo, tracks AI Security & Defense and Agent Economy, prize account `hadelive.near`, repository https://github.com/hadelive/payrein, demo post https://x.com/CrissEthan7au/status/2117162030889390370. The site answered "Submission received. Your project has been saved." The form cannot be edited; the repository and the post stay public through judging (16 to 18 November).

Everything the NEAR HACKATHON form and the X post need, in one place. The form takes one submission
per team and cannot be edited afterwards, so the owner sends it, not a script.

## Form fields

- **Tracks:** AI Security & Defense (primary), Agent Economy.
- **Repository:** https://github.com/hadelive/payrein (public since 2 November 2026).
- **Demo post:** https://x.com/CrissEthan7au/status/2117162030889390370 (posted 2 November 2026 with the video; the reply holds the repository and landing page links).
- **Website:** leave empty. The rules file calls this field a spam trap and rejects any value in
  it; the landing page (https://payrein.vercel.app) goes in the description instead.
- **Prize account:** `hadelive.near` (exists on mainnet, checked 2 November 2026).

## "What did you build?" (form, 20–2,000 characters)

The description as sent on 2 November 2026, kept verbatim as the record:

> Payrein lets an AI agent buy things from a NEAR Intents balance that a small Rust contract holds, not the agent. The agent has one function-call key that can only ask the vault to pay. The vault pays only allowlisted merchants, in one token, within a per-payment and a daily limit, and anything above an approval threshold waits until the owner approves that exact payment in their wallet. A hijacked prompt, a replaced agent binary or a leaked key changes none of that, because the checks run in the contract that moves the funds.

What is in the repository: the contract (near-sdk), 27 unit tests, 25 sandbox attack tests that run against the pinned intents.near binary that is live on mainnet (injected instructions, leaked key, tampered approval, replayed and expired payments, eight concurrent requests, stuck callbacks), a mutation check in which five targeted mutations are each caught by their covering test, a demo merchant that delivers only after verifying the payment on chain, an agent runner with a scripted or a NEAR AI Cloud model, an owner app that shows the exact call the wallet will sign, a one-command local demo, and a testnet bootstrap. The demo video shows the seven demo steps on the local devnet. Landing page: https://payrein.vercel.app. The README's threat model says what the contract does not protect: the owner key and Intents are trusted, a swapped but genuinely awaiting payment is caught only by reading the wallet, and the contract is unaudited. Work started on 21 October 2026, after the 19 October announcement; the git history is dated.

(1574 characters.)

## X post (under 280 characters; must say built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon)

> Built at NEAR HACKATHON: Payrein, a NEAR contract that holds an AI agent’s spending money. The agent can only ask to pay; the vault enforces the allowlist, spending caps and owner approval of the exact payment, even with a leaked key. Demo ↓ @NEARProtocol #NEARHackathon

(270 characters; attach the video file directly. Reply with the repository link
https://github.com/hadelive/payrein and the landing page https://payrein.vercel.app.)

## Demo video

**Recorded 1 November 2026 from the local devnet run** (the take on the submitted X post) and again on 2 November after the second merchant was added (56 s; the stills below are from that take; posted 12 November 2026 as a reply on the demo post, https://x.com/CrissEthan7au/status/2120783204865163565) by `scripts/record-demo.mjs` (headless
Chrome drives the seven demo buttons, captions each step on screen, records with CDP screencast;
`ffmpeg` assembles the frames): 55 seconds, 1920×1500, no sound. Stills of the approval card, the
tampered approval and the full daily bar are in `evidence/video-04-approval.png`,
`evidence/video-05-tampered.png` and `evidence/video-08-limit.png`. On devnet the owner's sandbox
key signs, so there is no wallet window; the wallet's display of `approve`'s arguments (T20) is not
in this take. Run it again with `node scripts/record-demo.mjs` while `make demo-local` is up on a
fresh sandbox (it needs `puppeteer-core` on the Node path and `ffmpeg`; the script prints the
`ffmpeg` command).

The testnet take below, with a real wallet, replaces it when the testnet setup in
[setup-checklist.md](setup-checklist.md) is done.

### Testnet take, 2–3 minutes (target 2:55)

Record on **testnet** with a real wallet: the wallet's approval screen is the one thing the local
devnet cannot show, and it is the T20 check. Say once that the testnet Intents is our copy of the
pinned mainnet binary, since testnet has no live Intents. Use a real-model run (`PLANNER=nearai`)
for the ordinary purchase and say that the attack scenarios force the agent's decision. For T9,
**submit** the mismatched transaction so the contract's refusal is seen; cancelling in the wallet
would prove nothing. Screen only, the owner app left, the wallet window right when it appears. The
app's demo steps are numbered 1–7 on screen; run them in order.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:15 | Header with the testnet badge, the vault summary and the budget bar | "The agent can buy data, but the contract holds the funds and enforces the spending policy." |
| 0:15–0:35 | **1 Buy a report.** Agent panel: offers, invoice, `accepted as op 1`, `report delivered`. Budget: 0.002 spent. | "Normal purchase. The merchant delivers only after verifying the payment on chain." |
| 0:35–0:55 | **2 T1 injected merchant.** The invoice's injected text in red, `decided to pay attacker…`, then `refused: MerchantNotAllowed`. | "The invoice tells AI agents to pay another account, and this time the agent obeys. The vault refuses: not on the allowlist. The attacker still has nothing." |
| 0:55–1:10 | **3 T2 leaked key.** The same refusal from a script holding the agent's key. | "A stolen agent key meets the same contract checks. The app isn't in the loop; the contract is." |
| 1:10–1:30 | **4 Buy (needs approval).** Approvals card: 0.008 against the 0.005 threshold, merchant, expiry, the agent's note marked *not checked*, "Exact call your wallet will show". | "Above the threshold, so it waits for me, and I approve these exact details." |
| 1:30–1:55 | **5 T9 tampered approval.** The wallet shows 0.009; submit it; the app shows `ApprovalMismatch`. | "A tampered app asks my wallet for a different amount. The wallet shows the real arguments, and the contract compares every field: refused. One thing the contract can't catch: an app swapping in a different payment that is also genuinely waiting. For that, the wallet's own display is the protection, so I read the wallet, not the app." |
| 1:55–2:20 | **6 Approve in wallet.** The wallet shows `approve` with the full op; confirm. Activity: Settled; Agent: `report delivered`. Spent 0.010. | "The real approval. Paid, verified, delivered." |
| 2:20–2:40 | **7 T5 8 at once.** Eight requests of 0.004, `5 accepted, 3 refused`, three `OverDaily`. The bar stops at 0.030. | "Eight requests at once from eight keys with 0.020 left: exactly five settle. The vault reserves before it sends, so a race can't overspend." |
| 2:40–2:55 | Hold on the full bar, then the README evidence table and the repo URL. | "25 attack tests against the real Intents code, five mutations caught. Unaudited; the owner key and Intents are trusted, and the README says so." |

Before recording: `make testnet` done and rehearsed once, the wallet confirmed to show all of
`approve`'s fields, `PLANNER=nearai make demo-testnet` running, the wallet signed in as the vault
owner, and an untouched daily budget (it resets at 00:00 UTC); keep the whole take inside one UTC
day. Record in the light palette.
