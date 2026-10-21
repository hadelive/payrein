// The agent runner's step log: initial fetch, then live steps over SSE.

import { useEffect, useState } from "react";
import { cfg } from "./chain";

export interface Step {
  seq: number;
  at: string;
  run: string;
  kind: "task" | "offers" | "invoice" | "model" | "request" | "vault" | "deliver" | "error";
  text: string;
  data?: unknown;
}

export interface Refusal {
  at: string;
  run: string;
  req: { merchant_id: string; amount: string; invoice_ref: string };
  error: string;
  txHash?: string;
}

export interface AgentLog {
  steps: Step[];
  refusals: Refusal[];
  online: boolean;
}

export function useAgentLog(): AgentLog {
  const [log, setLog] = useState<AgentLog>({ steps: [], refusals: [], online: false });

  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try {
        const res = await fetch(`${cfg.agentUrl}/log`);
        const body = (await res.json()) as { steps: Step[]; refusals: Refusal[] };
        if (!closed) setLog({ ...body, online: true });
      } catch {
        if (!closed) setLog((l) => ({ ...l, online: false }));
      }
    };
    void refresh();
    const es = new EventSource(`${cfg.agentUrl}/events`);
    es.addEventListener("step", (e) => {
      const step = JSON.parse((e as MessageEvent<string>).data) as Step;
      setLog((l) => (l.steps.some((s) => s.seq === step.seq) ? l : { ...l, online: true, steps: [...l.steps, step].slice(-300) }));
      // Refusals are derived server-side; refetch them when the vault answers.
      if (step.kind === "vault") void refresh();
    });
    es.onerror = () => setLog((l) => ({ ...l, online: false }));
    es.onopen = () => void refresh();
    return () => {
      closed = true;
      es.close();
    };
  }, []);

  return log;
}

/** The agent's own note on an op (the model's words), shown to the owner as unchecked. */
export function agentNote(steps: Step[], opId: string): string | undefined {
  const accepted = steps.find(
    (s) => s.kind === "vault" && (s.data as { op?: { op_id?: string } } | undefined)?.op?.op_id === opId,
  );
  if (!accepted) return undefined;
  const notes = steps.filter((s) => s.run === accepted.run && (s.kind === "model" || s.kind === "task")).map((s) => s.text);
  return notes.length ? notes.join(" · ") : undefined;
}

export async function agentPost(path: string, body: object = {}): Promise<string | undefined> {
  try {
    const res = await fetch(`${cfg.agentUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return ((await res.json()) as { error?: string }).error ?? `agent runner ${res.status}`;
    return undefined;
  } catch (e) {
    return `agent runner unreachable: ${(e as Error).message}`;
  }
}
