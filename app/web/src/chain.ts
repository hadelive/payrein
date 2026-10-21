// Read-only chain access: the vault's views and Intents balances over JSON-RPC. Numbers stay as
// the decimal strings the contract returns (T25).

import type { Budget, PaymentOp } from "./explain";

export const cfg = {
  network: (import.meta.env.VITE_NETWORK ?? "mainnet") as "mainnet" | "devnet",
  rpcUrl: import.meta.env.VITE_RPC_URL ?? "https://free.rpc.fastnear.com",
  vaultId: required("VITE_VAULT_ID"),
  intentsId: import.meta.env.VITE_INTENTS_ID ?? "intents.near",
  agentUrl: import.meta.env.VITE_AGENT_URL ?? "http://localhost:8788",
  demo: import.meta.env.VITE_DEMO === "1",
};

function required(name: string): string {
  const v = import.meta.env[name] as string | undefined;
  if (!v) throw new Error(`${name} is not set (see app/web/.env.example)`);
  return v;
}

export interface Policy {
  version: number;
  token_id: string;
  per_payment_max: string;
  daily_max: string;
  approval_threshold: string;
  max_ttl_sec: number;
  max_pending: number;
  paused: boolean;
}

export interface VaultConfig {
  owner: string;
  agent: string;
  intents: string;
  policy: Policy;
  next_op_id: string;
}

export interface Merchant {
  account_id: string;
  label: string;
}

export type OpStatus = "AwaitingApproval" | "Dispatched" | "Settled" | "Failed" | "Rejected" | "Released";

export interface OpRecord {
  op: PaymentOp;
  status: OpStatus;
  day: string | null;
  created_ns: string;
  dispatched_ns: string | null;
  finished_ns: string | null;
}

export interface VaultState {
  config: VaultConfig;
  merchants: Merchant[];
  ops: OpRecord[];
  budget: Budget & { day: string };
  balance: string;
  token: { symbol: string; decimals: number };
  loadedAt: Date;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "web", method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

let tokenMeta: { symbol: string; decimals: number } | undefined;

export async function loadState(): Promise<VaultState> {
  const [config, merchants, ops, budget] = await Promise.all([
    view<VaultConfig>(cfg.vaultId, "get_config"),
    view<Merchant[]>(cfg.vaultId, "get_merchants"),
    view<OpRecord[]>(cfg.vaultId, "list_ops"),
    view<Budget & { day: string }>(cfg.vaultId, "budget"),
  ]);
  const token = config.policy.token_id;
  if (!tokenMeta) {
    const ft = token.replace(/^nep141:/, "");
    tokenMeta = await view<{ symbol: string; decimals: number }>(ft, "ft_metadata");
  }
  const balance = await view<string>(cfg.intentsId, "mt_balance_of", { account_id: cfg.vaultId, token_id: token });
  return { config, merchants, ops, budget, balance, token: tokenMeta, loadedAt: new Date() };
}

export function explorerTx(hash: string): string | undefined {
  return cfg.network === "mainnet" ? `https://nearblocks.io/txns/${hash}` : undefined;
}
