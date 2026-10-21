// HTTP and SSE front of the agent runner for the owner app. The owner app holds no keys; these
// endpoints act with the agent's restricted keys only.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { KeyPairString } from "near-api-js";
import { Agent, type Step } from "./agent.js";
import { VaultClient } from "./near.js";
import { NearAiPlanner, ScriptedPlanner, type Planner } from "./planner.js";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${name} is required (see .env.example)`);
  return v;
};

function planner(): Planner {
  const kind = env("PLANNER");
  if (kind === "scripted") return new ScriptedPlanner();
  if (kind === "nearai") {
    return new NearAiPlanner(env("NEARAI_URL", "https://cloud-api.near.ai/v1"), env("NEARAI_API_KEY"), env("NEARAI_MODEL"));
  }
  throw new Error(`PLANNER must be "nearai" or "scripted", got ${kind}`);
}

const vault = new VaultClient(
  env("RPC_URL"),
  env("VAULT_ID"),
  env("AGENT_ID"),
  env("AGENT_KEYS").split(",").map((k) => k.trim() as KeyPairString),
);
const agent = new Agent(vault, planner(), env("MERCHANT_URL"));
const merchantId = env("MERCHANT_ID");
const attackerId = env("ATTACKER_ID");

const app = new Hono();
app.use("*", cors({ origin: env("APP_ORIGIN", "http://localhost:5173,http://127.0.0.1:5173").split(",") }));

app.get("/log", (c) => c.json({ steps: agent.steps, refusals: agent.refusals }));

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const send = (s: Step) => void stream.writeSSE({ event: "step", data: JSON.stringify(s), id: String(s.seq) });
    agent.on("step", send);
    stream.onAbort(() => {
      agent.off("step", send);
    });
    while (!stream.aborted) await stream.sleep(15_000);
  }),
);

// Long-running actions return at once; progress arrives on /events.
app.post("/buy", async (c) => {
  const { task, compromised } = await c.req.json<{ task?: string; compromised?: boolean }>();
  void agent.buy(task ?? "Buy this week's NEAR ecosystem report", compromised === true);
  return c.json({ started: true }, 202);
});

app.post("/attack/direct-call", async (c) => {
  const { amount } = await c.req.json<{ amount?: string }>().catch(() => ({ amount: undefined }));
  void agent.directCall(attackerId, amount ?? "2000000000000000000000");
  return c.json({ started: true }, 202);
});

app.post("/attack/parallel", async (c) => {
  const { amount, count } = await c.req.json<{ amount?: string; count?: number }>().catch(() => ({}) as { amount?: string; count?: number });
  void agent.parallel(merchantId, amount ?? "4000000000000000000000", count ?? 8);
  return c.json({ started: true }, 202);
});

app.post("/approved", async (c) => {
  const { op_id, tx_hash, signer_id } = await c.req.json<{ op_id?: string; tx_hash?: string; signer_id?: string }>();
  if (!op_id || !tx_hash || !signer_id) return c.json({ error: "op_id, tx_hash and signer_id are required" }, 400);
  try {
    await agent.approved(op_id, tx_hash, signer_id);
    return c.json({ delivered: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

const port = Number(env("PORT", "8788"));
serve({ fetch: app.fetch, port }, () => {
  console.log(`agent runner on :${port}, vault ${vault.vaultId}, ${vault.keyCount} keys`);
});
