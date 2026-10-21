import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { agentNote, agentPost, useAgentLog, type Refusal, type Step } from "./agentLog";
import { cfg, explorerTx, finalOutcome, loadState, type OpRecord, type VaultState } from "./chain";
import { explain, formatAmount, rejectionSentence, safeAmount, utcTime, type PaymentOp } from "./explain";
import { createSigner, takeRedirectResult, vaultError as vaultCode, type OwnerSigner } from "./signer";

const POLL_MS = 2000;

type Notice = { tone: "ok" | "bad"; text: string; tx?: string } | null;

function useVault() {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await loadState());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);
  return { state, error, refresh };
}

function useSigner() {
  const [signer, setSigner] = useState<OwnerSigner | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    createSigner()
      .then((s) => {
        setSigner(s);
        setAccount(s.accountId());
        s.onChange(() => setAccount(s.accountId()));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  return { signer, account, error };
}

export function App() {
  const { state, error, refresh } = useVault();
  const { signer, account, error: signerError } = useSigner();
  const log = useAgentLog();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = !!state && account === state.config.owner;

  // Owner signs `method`; for an approval, tell the agent runner so the merchant can deliver.
  const ownerCall = useCallback(
    async (method: string, args: object, label: string) => {
      if (!signer) return;
      setBusy(true);
      const r = await signer.call(method, args);
      setBusy(false);
      if (r.error) setNotice({ tone: "bad", text: `${label}: ${rejectionSentence(r.error)} (${r.error})`, tx: r.txHash });
      else if (r.txHash) {
        setNotice({ tone: "ok", text: `${label}: done`, tx: r.txHash });
        if (method === "approve") {
          const op = (args as { op: PaymentOp }).op;
          const err = await agentPost("/approved", { op_id: op.op_id, tx_hash: r.txHash, signer_id: account });
          if (err) setNotice({ tone: "bad", text: `Approved, but delivery failed: ${err}`, tx: r.txHash });
        }
      }
      void refresh();
    },
    [signer, account, refresh],
  );

  // Finish a call a redirect wallet left the page for.
  useEffect(() => {
    if (!account) return;
    const done = takeRedirectResult();
    if (!done) return;
    if (done.error || !done.txHash) {
      setNotice({ tone: "bad", text: `${done.method}: the wallet reported ${done.error ?? "no transaction"}` });
      return;
    }
    const txHash = done.txHash;
    setNotice({ tone: "ok", text: `${done.method}: waiting for the transaction to finish…`, tx: txHash });
    void (async () => {
      // The return URL only proves the wallet sent something; check the transaction's final result.
      const fin = await finalOutcome(txHash, account);
      if (!fin.ok) {
        const code = vaultCode(fin.error);
        setNotice({ tone: "bad", text: `${done.method}: ${rejectionSentence(code)} (${code})`, tx: txHash });
        return;
      }
      setNotice({ tone: "ok", text: `${done.method}: done`, tx: txHash });
      if (done.method === "approve") {
        const op = (done.args as { op: PaymentOp }).op;
        const err = await agentPost("/approved", { op_id: op.op_id, tx_hash: txHash, signer_id: account });
        if (err) setNotice({ tone: "bad", text: `Approved, but delivery failed: ${err}`, tx: txHash });
      }
    })();
  }, [account]);

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Agent Payment Vault</h1>
          <p className="sub">Compromise the agent. The spending limits still hold.</p>
        </div>
        <div className="who">
          <span className={`badge ${cfg.network}`}>{cfg.network}</span>
          {signerError && <span className="bad">{signerError}</span>}
          {signer && account && (
            <span>
              {signer.kind}: <b>{account}</b>
              {state && !isOwner && <span className="bad"> (not the vault owner; read-only)</span>}
            </span>
          )}
          {signer && !account && <button onClick={() => void signer.signIn()}>Connect wallet</button>}
          {signer?.kind === "wallet" && account && <button className="ghost" onClick={() => void signer.signOut()}>Sign out</button>}
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          {notice.tx && <TxLink hash={notice.tx} />}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {error && (
        <div className="notice bad">
          Can't read the vault: {error}
          {state && <> Showing data from {state.loadedAt.toLocaleTimeString()}.</>}
        </div>
      )}

      {!state ? (
        <p className="muted">{error ? "No vault data yet." : "Loading the vault…"}</p>
      ) : (
        <>
          {cfg.demo && <DemoStrip state={state} canSign={isOwner} busy={busy} ownerCall={ownerCall} setNotice={setNotice} />}
          <div className="grid">
            <VaultPanel state={state} canSign={isOwner} busy={busy} ownerCall={ownerCall} />
            <Approvals state={state} steps={log.steps} canSign={isOwner} busy={busy} ownerCall={ownerCall} />
            <Isolated name="Activity">
              <Activity state={state} refusals={log.refusals} />
            </Isolated>
            <Isolated name="Agent">
              <AgentPanel steps={log.steps} online={log.online} decimals={state.token.decimals} symbol={state.token.symbol} />
            </Isolated>
          </div>
        </>
      )}
    </div>
  );
}

type OwnerCall = (method: string, args: object, label: string) => Promise<void>;

/** Panels that render agent-supplied data fail alone, so the owner keeps approve, reject and pause. */
class Isolated extends Component<{ name: string; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="panel">
        <h2>{this.props.name}</h2>
        <p className="bad">This panel could not render: {this.state.error}</p>
      </section>
    );
  }
}

function TxLink({ hash }: { hash: string }) {
  const href = explorerTx(hash);
  const short = `${hash.slice(0, 8)}…`;
  return href ? (
    <a className="tx" href={href} target="_blank" rel="noreferrer">
      {short}
    </a>
  ) : (
    <code className="tx" title={hash}>{short}</code>
  );
}

function BudgetBar({ state }: { state: VaultState }) {
  const { daily_max, spent, reserved, remaining } = state.budget;
  const max = Number(BigInt(daily_max)) || 1;
  const pct = (x: string) => `${Math.min(100, (Number(BigInt(x)) / max) * 100)}%`;
  const f = (x: string) => formatAmount(x, state.token.decimals, 4);
  return (
    <div>
      <div className="bar" role="img" aria-label={`Spent ${f(spent)}, pending ${f(reserved)} of ${f(daily_max)}`}>
        <span className="spent" style={{ width: pct(spent) }} />
        <span className="pending" style={{ width: pct(reserved) }} />
      </div>
      <div className="legend">
        <span><i className="dot spent" />spent {f(spent)}</span>
        <span><i className="dot pending" />pending {f(reserved)}</span>
        <span>left {f(remaining)}</span>
        <span>limit {f(daily_max)} {state.token.symbol} / UTC day</span>
      </div>
    </div>
  );
}

function VaultPanel({ state, canSign, busy, ownerCall }: { state: VaultState; canSign: boolean; busy: boolean; ownerCall: OwnerCall }) {
  const p = state.config.policy;
  const f = (x: string) => `${formatAmount(x, state.token.decimals, 4)} ${state.token.symbol}`;
  const [withdraw, setWithdraw] = useState("");
  const withdrawBase = useMemo(() => {
    if (!/^\d+(\.\d+)?$/.test(withdraw)) return null;
    const [w, frac = ""] = withdraw.split(".");
    return (BigInt(w!) * 10n ** BigInt(state.token.decimals) + BigInt(frac.padEnd(state.token.decimals, "0").slice(0, state.token.decimals) || "0")).toString();
  }, [withdraw, state.token.decimals]);

  return (
    <section className="panel vault">
      <h2>Vault</h2>
      <dl className="kv">
        <dt>Vault</dt><dd><code>{cfg.vaultId}</code></dd>
        <dt>Intents balance</dt><dd>{f(state.balance)}</dd>
        <dt>Agent</dt><dd><code>{state.config.agent}</code></dd>
        <dt>Status</dt><dd>{p.paused ? <span className="bad">Paused</span> : "Active"}</dd>
      </dl>
      <h3>Today</h3>
      <BudgetBar state={state} />
      <h3>Policy v{p.version}</h3>
      <dl className="kv">
        <dt>Per payment</dt><dd>{f(p.per_payment_max)}</dd>
        <dt>Needs approval above</dt><dd>{f(p.approval_threshold)}</dd>
        <dt>Max pending</dt><dd>{p.max_pending}</dd>
        <dt>Max request lifetime</dt><dd>{p.max_ttl_sec} s</dd>
      </dl>
      <h3>Allowlist</h3>
      {state.merchants.length === 0 ? (
        <p className="muted">No merchants: every payment will be refused.</p>
      ) : (
        <ul className="plain">
          {state.merchants.map((m) => (
            <li key={m.account_id}><b>{m.label}</b> <code>{m.account_id}</code></li>
          ))}
        </ul>
      )}
      {canSign && (
        <div className="actions">
          <button disabled={busy} onClick={() => void ownerCall(p.paused ? "unpause" : "pause", {}, p.paused ? "Unpause" : "Pause")}>
            {p.paused ? "Unpause" : "Pause"}
          </button>
          <label className="inline">
            Withdraw
            <input value={withdraw} onChange={(e) => setWithdraw(e.target.value.trim())} placeholder="0.01" inputMode="decimal" />
          </label>
          <button
            disabled={busy || !withdrawBase || withdrawBase === "0"}
            onClick={() => void ownerCall("withdraw", { amount: withdrawBase }, `Withdraw ${withdraw}`)}
          >
            Withdraw
          </button>
          {withdrawBase && <pre className="call">withdraw({JSON.stringify({ amount: withdrawBase })})</pre>}
        </div>
      )}
    </section>
  );
}

function Approvals({ state, steps, canSign, busy, ownerCall }: { state: VaultState; steps: Step[]; canSign: boolean; busy: boolean; ownerCall: OwnerCall }) {
  const awaiting = state.ops.filter((r) => r.status === "AwaitingApproval");
  const now = BigInt(Date.now()) * 1_000_000n;
  return (
    <section className="panel approvals">
      <h2>Approvals</h2>
      {awaiting.length === 0 && <p className="muted">Nothing is waiting for you.</p>}
      {awaiting.map((r) => {
        const label = state.merchants.find((m) => m.account_id === r.op.merchant_id)?.label;
        const e = explain(r.op, {
          vaultId: cfg.vaultId,
          symbol: state.token.symbol,
          decimals: state.token.decimals,
          merchantLabel: label,
          approvalThreshold: state.config.policy.approval_threshold,
          budget: state.budget,
        });
        const expired = BigInt(r.op.expires_at_ns) <= now;
        const note = agentNote(steps, r.op.op_id);
        return (
          <article key={r.op.op_id} className="card">
            <p className="headline">{e.headline}</p>
            <p>{e.budget}</p>
            {e.reason && <p>{e.reason}</p>}
            <p className={expired ? "bad" : "muted"}>{expired ? "Expired." : e.expires}</p>
            {note && (
              <div className="note">
                <span className="note-label">Agent's note (not checked)</span>
                {note}
              </div>
            )}
            <details>
              <summary>Exact call your wallet will show</summary>
              <pre className="call">approve({JSON.stringify({ op: r.op }, null, 2)})</pre>
            </details>
            {canSign && (
              <div className="actions">
                {!expired && (
                  <button disabled={busy} onClick={() => void ownerCall("approve", { op: r.op }, `Approve op ${r.op.op_id}`)}>
                    Approve
                  </button>
                )}
                <button className="ghost" disabled={busy} onClick={() => void ownerCall("reject", { op_id: r.op.op_id }, `Reject op ${r.op.op_id}`)}>
                  Reject
                </button>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function Activity({ state, refusals }: { state: VaultState; refusals: Refusal[] }) {
  // Each op in its own token's units; refusals come from the agent's log and may hold anything.
  const opAmount = (op: PaymentOp) => {
    const t = state.tokens[op.token_id] ?? state.token;
    return `${safeAmount(op.amount, t.decimals, 4)}${op.token_id === state.config.policy.token_id ? "" : ` ${t.symbol}`}`;
  };
  const f = (x: unknown) => (typeof x === "string" ? safeAmount(x, state.token.decimals, 4) : String(x));
  const label = (id: string) => state.merchants.find((m) => m.account_id === id)?.label ?? id;
  type Row = { key: string; at: number; who: string; amount: string; status: string; tone: string; detail: string; tx?: string };
  const rows: Row[] = [
    ...state.ops.map((r: OpRecord) => ({
      key: `op-${r.op.op_id}`,
      at: Number(BigInt(r.created_ns) / 1_000_000n),
      who: label(r.op.merchant_id),
      amount: opAmount(r.op),
      status: r.status,
      tone: r.status === "Settled" ? "ok" : r.status === "Failed" || r.status === "Rejected" ? "bad" : "",
      detail: `op ${r.op.op_id} · ${r.op.invoice_ref}`,
    })),
    ...refusals.map((x, i) => ({
      key: `ref-${i}-${x.at}`,
      at: Date.parse(x.at),
      who: label(x.req.merchant_id),
      amount: f(x.req.amount),
      status: "Refused",
      tone: "bad",
      detail: `${rejectionSentence(x.error)} (from the agent's log)`,
      tx: x.txHash,
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <section className="panel activity">
      <h2>Activity</h2>
      {rows.length === 0 ? (
        <p className="muted">No payments yet.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Time</th><th>Merchant</th><th>Amount</th><th>Status</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{new Date(r.at).toLocaleTimeString()}</td>
                <td>{r.who}</td>
                <td className="num">{r.amount}</td>
                <td className={r.tone}>{r.status}</td>
                <td>{r.detail} {r.tx && <TxLink hash={r.tx} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AgentPanel({ steps, online, decimals, symbol }: { steps: Step[]; online: boolean; decimals: number; symbol: string }) {
  const recent = [...steps].reverse().slice(0, 60);
  // The runner logs base units; show them as token amounts.
  const readable = (text: string) => text.replace(/\b\d{16,}\b/g, (n) => `${formatAmount(n, decimals, 6)} ${symbol}`);
  return (
    <section className="panel agent">
      <h2>Agent {online ? <span className="ok small">live</span> : <span className="bad small">runner offline</span>}</h2>
      {recent.length === 0 && <p className="muted">The agent has not done anything yet.</p>}
      <ol className="steps">
        {recent.map((s) => {
          const notes = s.kind === "invoice" ? (s.data as { notes?: string } | undefined)?.notes : undefined;
          return (
            <li key={s.seq} className={s.kind}>
              <span className="when">{new Date(s.at).toLocaleTimeString()}</span>
              <span className="kind">{s.kind}</span>
              <span>{readable(s.text)}</span>
              {notes && <div className="injected">Merchant text: {notes}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function DemoStrip({ state, canSign, busy, ownerCall, setNotice }: {
  state: VaultState;
  canSign: boolean;
  busy: boolean;
  ownerCall: OwnerCall;
  setNotice: (n: Notice) => void;
}) {
  const run = async (path: string, body: object, label: string) => {
    const err = await agentPost(path, body);
    setNotice(err ? { tone: "bad", text: `${label}: ${err}` } : { tone: "ok", text: `${label}: started; watch the Agent panel` });
  };
  const awaiting = state.ops.find((r) => r.status === "AwaitingApproval");
  const milli = 10n ** BigInt(state.token.decimals - 3);
  return (
    <section className="demo">
      <span className="demo-label">Demo</span>
      <button onClick={() => void run("/buy", { task: "Buy near-weekly" }, "Purchase")}>Buy a report</button>
      <button onClick={() => void run("/buy", { task: "Buy intents-deep-dive" }, "Purchase")}>Buy (needs approval)</button>
      <button className="attack" onClick={() => void run("/buy", { task: "Buy near-weekly", compromised: true }, "T1")}>T1 injected merchant</button>
      <button className="attack" onClick={() => void run("/attack/direct-call", {}, "T2")}>T2 leaked key</button>
      <button className="attack" onClick={() => void run("/attack/parallel", { amount: (4n * milli).toString(), count: 8 }, "T5")}>T5 8 at once</button>
      {canSign && awaiting && (
        <button
          className="attack"
          disabled={busy}
          title="A tampered app asks the wallet to approve a different amount than the stored payment"
          onClick={() =>
            void ownerCall("approve", { op: { ...awaiting.op, amount: (BigInt(awaiting.op.amount) + milli).toString() } }, "T9 tampered approval")
          }
        >
          T9 tampered approval
        </button>
      )}
      <span className="muted small">Expires: {awaiting ? utcTime(awaiting.op.expires_at_ns) : "no approval pending"}</span>
    </section>
  );
}
