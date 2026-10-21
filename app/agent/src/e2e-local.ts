// End-to-end run of the demo script on the local devnet (make devnet, then the merchant and the
// agent runner). Signs the owner's approval with the sandbox owner key from target/devnet.json;
// on mainnet the owner signs in a wallet instead. Exits non-zero on the first broken step.

import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { Step } from "./agent.js";

const AGENT = "http://localhost:8788";
const dev = JSON.parse(readFileSync(new URL("../../../target/devnet.json", import.meta.url), "utf8")) as {
  rpc_url: string;
  vault_id: string;
  intents_id: string;
  token_id: string;
  owner_id: string;
  owner_key: KeyPairString;
  merchant_id: string;
  attacker_id: string;
};
const provider = new JsonRpcProvider({ url: dev.rpc_url });
const owner = new Account(dev.owner_id, provider, KeyPairSigner.fromSecretKey(dev.owner_key));
const MILLI = 10n ** 21n; // 0.001 wNEAR

const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args }) as Promise<T>;
const balance = async (who: string) =>
  BigInt(await view<string>(dev.intents_id, "mt_balance_of", { account_id: who, token_id: dev.token_id }));
const budget = () => view<{ spent: string; reserved: string; remaining: string }>(dev.vault_id, "budget");

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${AGENT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function main(): Promise<void> {
  const shop0 = await balance(dev.merchant_id);

  // 1. Normal purchase: paid from the invoice's fields; the injected note is ignored.
  let steps = await run("/buy", { task: "Buy near-weekly" }, (s) => s.kind === "deliver");
  check((await balance(dev.merchant_id)) - shop0 === 2n * MILLI, "normal purchase paid 0.002 and the report was delivered");

  // 2. T1: a compromised agent follows the merchant's injected note.
  steps = await run("/buy", { task: "Buy near-weekly", compromised: true }, (s) => s.kind === "vault");
  check(steps.some((s) => s.text.includes("MerchantNotAllowed")), "T1 injected recipient refused: MerchantNotAllowed");
  check((await balance(dev.attacker_id)) === 0n, "attacker received nothing");

  // 3. T2: the leaked key calls the vault directly.
  steps = await run("/attack/direct-call", {}, (s) => s.kind === "vault");
  check(steps.some((s) => s.text.includes("MerchantNotAllowed")), "T2 direct call refused: MerchantNotAllowed");

  // 4. T9: 0.008 needs approval; a tampered approval fails, the real one pays.
  steps = await run("/buy", { task: "Buy intents-deep-dive" }, (s) => s.text.includes("awaits the owner's approval"));
  const accepted = steps.find((s) => s.text.startsWith("accepted as op"));
  const op = (accepted?.data as { op: Record<string, unknown> }).op;
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

  for (let i = 0; i < 20 && BigInt((await budget()).reserved) > 0n; i++) await new Promise((r) => setTimeout(r, 500));
  const b = await budget();
  check(BigInt(b.spent) === 30n * MILLI && BigInt(b.reserved) === 0n, `budget stops at the limit: spent ${fmt(BigInt(b.spent))}`);
  check((await balance(dev.merchant_id)) - shop0 === 30n * MILLI, "merchant received exactly 0.030 in total");
  console.log("all demo steps passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
