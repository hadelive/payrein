# Testnet run (6 Nov 2026)

The whole stack on NEAR testnet under `payrein-hv-3.testnet`, deployed by `make testnet` and
driven by `pnpm --filter @vault/agent e2e testnet` (scripted planner, demo policy: per payment 0.01,
approval above 0.005, daily 0.03 wNEAR). Testnet has no live Intents, so `intents.payrein-hv-3.testnet`
runs the pinned mainnet binary (code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`, the same as
`intents.near`); payments are in the live `wrap.testnet`.

| Account | Role | Explorer |
|---|---|---|
| `vault.payrein-hv-3.testnet` | the policy vault | https://testnet.nearblocks.io/address/vault.payrein-hv-3.testnet |
| `agent.payrein-hv-3.testnet` | the agent | https://testnet.nearblocks.io/address/agent.payrein-hv-3.testnet |
| `intents.payrein-hv-3.testnet` | Intents (pinned mainnet binary) | https://testnet.nearblocks.io/address/intents.payrein-hv-3.testnet |
| `shop.payrein-hv-3.testnet` | Report Shop, allowlisted | https://testnet.nearblocks.io/address/shop.payrein-hv-3.testnet |
| `desk.payrein-hv-3.testnet` | Data Desk, allowlisted, overquotes one item | https://testnet.nearblocks.io/address/desk.payrein-hv-3.testnet |
| `attacker.payrein-hv-3.testnet` | the injected recipient, not allowlisted | https://testnet.nearblocks.io/address/attacker.payrein-hv-3.testnet |
| `payrein-hv-3.testnet` | owner | https://testnet.nearblocks.io/address/payrein-hv-3.testnet |

## End-to-end output

The owner's approval in this run is signed from the testnet key file by the script; the wallet
check of the same call (T20) is a separate, manual step, not yet done.

```
ok   offers read from both merchants
ok   the cheaper offer (Report Shop, 0.002) was chosen
ok   normal purchase paid 0.002 and the report was delivered
ok   T1 injected recipient refused: MerchantNotAllowed
ok   attacker received nothing
ok   T2 direct call refused: MerchantNotAllowed
ok   the cheaper quote (Data Desk, 0.006) was chosen first
ok   T26 dishonest invoice refused without paying: refused desk.payrein-hv-3.testnet's invoice, nothing paid: invoiced 9000000000000000000000, quoted 6000000000000000000000
ok   Data Desk received nothing
ok   fell back to Report Shop's honest 0.008 invoice
ok   T9 tampered approval refused: ApprovalMismatch
     owner approval: https://testnet.nearblocks.io/txns/8VCsrQPKvwVkPGMQURQLPAxde1z2r4W4r25SGGagAPDW
ok   approved payment of 0.008 delivered
ok   0.020 of the 0.030 daily budget left
ok   T5 parallel: 5 accepted, 3 refused
ok   the 3 refusals are OverDaily
ok   budget stops at the limit: spent 0.03
ok   merchant received exactly 0.030 in total
ok   Data Desk still has nothing
all demo steps passed
     accepted as op 1: https://testnet.nearblocks.io/txns/A9L6QYr7bJnGF7nQ7YLH2edD1UMzP75thQyu6SsvkUkc
     accepted as op 2: https://testnet.nearblocks.io/txns/5f3Bp3SBhj4Q8tpE8TRpZZxSRVcN97LwxDnVdnJWmPKx
     accepted as op 7: https://testnet.nearblocks.io/txns/JCFd9SVkGYEf9LmTTLMZx7N3c8CLzyCLeLFBrojWEHxo
     accepted as op 3: https://testnet.nearblocks.io/txns/Ef7NMYfokvtNpQfKLJNLxhd7uCDEYkjjPqg8TXRHV4qn
     accepted as op 5: https://testnet.nearblocks.io/txns/6yKpRjkdHdfEp5qRA3vtzQRnafVW2uGbvCV1aCQ8NAbi
     accepted as op 6: https://testnet.nearblocks.io/txns/HRp7qFKdrD922AK2wo3CpUc21K1hpnHp9HCmN7dchSDg
     accepted as op 4: https://testnet.nearblocks.io/txns/8rK41FnhVZkgf8bcCSkDkCmMtypa5AUXJjBwh9jndrQY
```

The links after the checks are the agent's accepted `request_payment` transactions: op 1 is the
first purchase, op 2 the approved 0.008, ops 3 to 7 the five parallel requests admitted (the three
refused ones failed with `OverDaily` before reaching Intents).

## Read back from the chain afterwards (block 276436947, `test.rpc.fastnear.com`)

| Read | Result |
|---|---|
| `vault.budget()` | daily max 0.03, spent 0.03, reserved 0, remaining 0 wNEAR |
| `intents.mt_balance_of` for `nep141:wrap.testnet` | shop 0.03, desk 0, attacker 0 |
| Access keys | vault, intents, shop, desk, attacker: none. agent: 8 function-call keys, each receiver `vault.payrein-hv-3.testnet`, method `request_payment` only |
| `vault.get_config()` | owner `payrein-hv-3.testnet`, policy version 1, not paused, `next_op_id` 8 |

The bootstrap checks the same key inventory itself before it writes `target/testnet.json` and
refuses to finish if any of these accounts holds a full-access key.

## A failed first attempt

The first run, under `payrein-hv.testnet`, funded Intents with 14 NEAR. The code deployed, but its
`new` call fell 0.004 NEAR short of the state it writes. The process stopped after creating five
sub-accounts whose random keys it held only in memory, so those accounts are abandoned (about 15
testnet NEAR). Commit f60d48e raised Intents' funding to 15 NEAR and creates Intents before every
other account, so a failure there strands nothing else. The second run, above, used a fresh root.
