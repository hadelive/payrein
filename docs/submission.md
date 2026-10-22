# Submission kit

Everything the NEAR HACKATHON form and the X post need, in one place. The form takes one submission
per team and cannot be edited afterwards, so the owner sends it, not a script.

## Form fields

- **Tracks:** AI Security & Defense (primary), Agent Economy.
- **Repository:** the public GitHub URL (fill in).
- **Demo post:** the X post URL (fill in).
- **Website:** optional; leave empty unless the app is hosted.
- **Prize account:** the owner's mainnet account (fill in).

## "What did you build?" (form, 20–2,000 characters)

Submission-day text: it claims only what the repository holds by then. Before sending, replace the
bracketed part with what was actually completed in November.

> Agent Payment Vault lets an AI agent buy reports using a NEAR Intents balance held by a Rust
> contract. A restricted function-call key can request payments, but the contract enforces merchant
> allowlists, per-payment and daily caps, and owner approval of exact payment details. The demo
> covers injected instructions, a leaked key, tampered approval and concurrent spending. The repo
> records 25 sandbox attack tests against the live intents.near binary, a mutation check, [the
> testnet and mainnet deployments with their transactions, the wallet check and a real-model run],
> and discloses the pre-event prototype and the work completed during the hackathon.

(About 620 characters.)

## X post (under 280 characters, must say it was built at NEAR HACKATHON)

> Built at NEAR HACKATHON: Agent Payment Vault, extending a disclosed pre-event prototype. An agent
> buys reports with a NEAR Intents balance; the contract enforces merchant rules, spending caps and
> exact-payment approval—even if its key leaks. Demo ↓

(248 characters; attach the video. Put the repo link in a reply.)

## Demo video, 2–3 minutes (target 2:55)

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
| 1:30–1:55 | **5 T9 tampered approval.** The wallet shows 0.009; submit it; the app shows `ApprovalMismatch`. | "A tampered app asks my wallet for a different amount. The wallet shows the real arguments, and the contract compares every field: refused." |
| 1:55–2:20 | **6 Approve in wallet.** The wallet shows `approve` with the full op; confirm. Activity: Settled; Agent: `report delivered`. Spent 0.010. | "The real approval. Paid, verified, delivered." |
| 2:20–2:40 | **7 T5 8 at once.** Eight requests of 0.004, `5 accepted, 3 refused`, three `OverDaily`. The bar stops at 0.030. | "Eight requests at once from eight keys with 0.020 left: exactly five settle. The vault reserves before it sends, so a race can't overspend." |
| 2:40–2:55 | Hold on the full bar, then the README evidence table and the repo URL. | "25 attack tests against the real Intents code, five mutations caught. Unaudited; the owner key and Intents are trusted, and the README says so." |

Before recording: `make testnet` done and rehearsed once, the wallet confirmed to show all of
`approve`'s fields, `PLANNER=nearai make demo-testnet` running, the wallet signed in as the vault
owner, and an untouched daily budget (it resets at 00:00 UTC); keep the whole take inside one UTC
day. Record in the light palette.
