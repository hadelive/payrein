// End-to-end run of the demo script against `make demo-local` (devnet) or `make demo-testnet`.
// Signs the owner's approval itself: on devnet with the sandbox owner key, after checking the RPC is
// that exact sandbox (its genesis hash); on testnet with the owner's key file, after checking the
// chain id. On mainnet the owner signs in a wallet instead. Needs the day's budget unused. Exits
// non-zero on the first broken step.
//
// Usage: tsx src/e2e.ts devnet|testnet

import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { Step } from "./agent.js";

const AGENT = "http://localhost:8788";
const network = process.argv[2];
if (network !== "devnet" && network !== "testnet") throw new Error("usage: e2e.ts devnet|testnet");
const dev = JSON.parse(readFileSync(new URL(`../../../target/${network}.json`, import.meta.url), "utf8")) as {
  rpc_url: string;
  vault_id: string;
  intents_id: string;
  token_id: string;
  owner_id: string;
  owner_key?: KeyPairString;
  owner_key_file?: string;
  merchant_id: string;
  merchant2_id: string;
  attacker_id: string;
};
const agentEnv = Object.fromEntries(
  readFileSync(new URL("../../../target/agent.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const provider = new JsonRpcProvider({ url: dev.rpc_url });
function ownerKey(): KeyPairString {
  if (dev.owner_key) return dev.owner_key;
  // near-cli's legacy keychain format; near-cli-rs writes no account_id, the JS near-cli did.
  const file = JSON.parse(readFileSync(dev.owner_key_file!, "utf8")) as { account_id?: string; private_key: KeyPairString };
  if (file.account_id && file.account_id !== dev.owner_id) throw new Error(`${dev.owner_key_file} is not ${dev.owner_id}'s key`);
  return file.private_key;
}
const owner = new Account(dev.owner_id, provider, KeyPairSigner.fromSecretKey(ownerKey()));
const MILLI = 10n ** 21n; // 0.001 wNEAR

const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args }) as Promise<T>;
const balance = async (who: string) =>
  BigInt(await view<string>(dev.intents_id, "mt_balance_of", { account_id: who, token_id: dev.token_id }));
const budget = () => view<{ spent: string; reserved: string; remaining: string }>(dev.vault_id, "budget");

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${AGENT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentEnv.AGENT_API_TOKEN}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Starts an agent action and waits for its run to log a step matching `done`. */
async function run(path: string, body: unknown, done: (s: Step) => boolean): Promise<Step[]> {
  const before = ((await (await fetch(`${AGENT}/log`)).json()) as { steps: Step[] }).steps.at(-1)?.seq ?? 0;
  await post(path, body);
  for (let i = 0; i < 120; i++) {
    const { steps } = (await (await fetch(`${AGENT}/log`)).json()) as { steps: Step[] };
    const mine = steps.filter((s) => s.seq > before);
    if (mine.some(done)) return mine;
    if (mine.some((s) => s.kind === "error")) throw new Error(`run failed: ${JSON.stringify(mine, null, 2)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${path} did not finish`);
}

function check(ok: boolean, what: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exit(1);
}

const fmt = (x: bigint) => `${Number(x) / 1e24}`;
const txLink = (hash: string) => (network === "testnet" ? `https://testnet.nearblocks.io/txns/${hash}` : hash);

/** Refuses any chain but the one this run is for, before anything is signed. */
async function checkChain(): Promise<void> {
  const status = (await (
    await fetch(dev.rpc_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "e2e", method: "status", params: [] }),
    })
  ).json()) as { result: { chain_id: string; genesis_hash: string } };
  if (network === "devnet" && status.result.genesis_hash !== agentEnv.DEV_GENESIS) {
    throw new Error(`refusing to sign: ${dev.rpc_url} is not the sandbox the launcher started`);
  }
  if (network === "testnet" && (status.result.chain_id !== "testnet" || !dev.owner_id.endsWith(".testnet"))) {
    throw new Error(`refusing to sign: ${dev.rpc_url} reports chain ${status.result.chain_id}, not testnet`);
  }
}

async function main(): Promise<void> {
  await checkChain();
  const start = await budget();
  if (BigInt(start.spent) !== 0n || BigInt(start.reserved) !== 0n) {
    throw new Error(`today's budget is already in use (spent ${fmt(BigInt(start.spent))}); run again after 00:00 UTC`);
  }
  const shop0 = await balance(dev.merchant_id);

  // 1. Normal purchase: the cheapest of two merchants' offers, paid from the invoice's fields; the
  //    injected note is ignored.
  let steps = await run("/buy", { task: "Buy near-weekly" }, (s) => s.kind === "deliver");
  check(steps.some((s) => s.kind === "offers" && s.text.includes("from 2 merchants")), "offers read from both merchants");
  check(steps.some((s) => s.kind === "model" && s.text.includes(`from ${dev.merchant_id}`)), "the cheaper offer (Report Shop, 0.002) was chosen");
  check((await balance(dev.merchant_id)) - shop0 === 2n * MILLI, "normal purchase paid 0.002 and the report was delivered");

  // 2. T1: a compromised agent follows the merchant's injected note.
  steps = await run("/buy", { task: "Buy near-weekly", compromised: true }, (s) => s.kind === "vault");
  check(steps.some((s) => s.text.includes("MerchantNotAllowed")), "T1 injected recipient refused: MerchantNotAllowed");
  check((await balance(dev.attacker_id)) === 0n, "attacker received nothing");

  // 3. T2: the leaked key calls the vault directly.
  steps = await run("/attack/direct-call", {}, (s) => s.kind === "vault");
  check(steps.some((s) => s.text.includes("MerchantNotAllowed")), "T2 direct call refused: MerchantNotAllowed");

  // 4. T26 then T9: Data Desk quotes the deep dive cheaper (0.006) but invoices 0.009; the agent
  //    refuses it without paying and buys from Report Shop at 0.008, which needs approval. A
  //    tampered approval fails, the real one pays.
  steps = await run("/buy", { task: "Buy intents-deep-dive" }, (s) => s.text.includes("awaits the owner's approval"));
  check(steps.some((s) => s.kind === "model" && s.text.includes(`from ${dev.merchant2_id}`)), "the cheaper quote (Data Desk, 0.006) was chosen first");
  const quote = steps.find((s) => s.kind === "quote");
  check(quote !== undefined && quote.text.includes("quoted 6000000000000000000000") && quote.text.includes("invoiced 9000000000000000000000"), `T26 dishonest invoice refused without paying: ${quote?.text}`);
  check((await balance(dev.merchant2_id)) === 0n, "Data Desk received nothing");
  const accepted = steps.find((s) => s.text.startsWith("accepted as op"));
  const op = (accepted?.data as { op: Record<string, unknown> }).op;
  check(op.merchant_id === dev.merchant_id, "fell back to Report Shop's honest 0.008 invoice");
  const tampered = { ...op, amount: (9n * MILLI).toString() };
  const forged = await owner
    .callFunctionRaw({ contractId: dev.vault_id, methodName: "approve", args: { op: tampered }, deposit: 1n, gas: 100_000_000_000_000n, waitUntil: "FINAL" })
    .then((r) => JSON.stringify(r.status))
    .catch((e: Error) => e.message);
  check(forged.includes("ApprovalMismatch"), "T9 tampered approval refused: ApprovalMismatch");
  const approval = await owner.callFunctionRaw({
    contractId: dev.vault_id,
    methodName: "approve",
    args: { op },
    deposit: 1n,
    gas: 100_000_000_000_000n,
    waitUntil: "FINAL",
  });
  console.log(`     owner approval: ${txLink(approval.transaction.hash)}`);
  const delivered = (await post("/approved", { op_id: op.op_id, tx_hash: approval.transaction.hash, signer_id: dev.owner_id })) as {
    delivered?: boolean;
  };
  check(delivered.delivered === true, "approved payment of 0.008 delivered");

  // 5. T5: 8 requests of 0.004 at once with 0.020 left: exactly 5 dispatch.
  check(BigInt((await budget()).remaining) === 20n * MILLI, "0.020 of the 0.030 daily budget left");
  steps = await run("/attack/parallel", { amount: (4n * MILLI).toString(), count: 8 }, (s) => / accepted, \d+ refused/.test(s.text));
  const summary = steps.find((s) => / accepted, \d+ refused/.test(s.text))!.text;
  check(summary === "5 accepted, 3 refused", `T5 parallel: ${summary}`);
  check(steps.filter((s) => s.text.includes("OverDaily")).length === 3, "the 3 refusals are OverDaily");

  for (let i = 0; i < 60 && BigInt((await budget()).reserved) > 0n; i++) await new Promise((r) => setTimeout(r, 1000));
  const b = await budget();
  check(BigInt(b.spent) === 30n * MILLI && BigInt(b.reserved) === 0n, `budget stops at the limit: spent ${fmt(BigInt(b.spent))}`);
  check((await balance(dev.merchant_id)) - shop0 === 30n * MILLI, "merchant received exactly 0.030 in total");
  check((await balance(dev.merchant2_id)) === 0n, "Data Desk still has nothing");
  console.log("all demo steps passed");
  const { steps: all } = (await (await fetch(`${AGENT}/log`)).json()) as { steps: Step[] };
  for (const s of all) {
    const hash = (s.data as { txHash?: string } | undefined)?.txHash;
    if (s.kind === "vault" && hash) console.log(`     ${s.text}: ${txLink(hash)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
