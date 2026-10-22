import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { agentNote, agentPost, useAgentLog, type Refusal, type Step } from "./agentLog";
import { cfg, explorerTx, finalOutcome, loadState, type OpRecord, type VaultState } from "./chain";
import { explain, formatAmount, rejectionSentence, safeAmount, type PaymentOp } from "./explain";
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
          <h1>Agent Payment Vault <span className={`badge ${cfg.network}`}>{cfg.network}</span></h1>
          <p className="sub">Compromise the agent. The spending limits still hold.</p>
        </div>
        <div className="who">
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
          <VaultPanel state={state} canSign={isOwner} busy={busy} ownerCall={ownerCall} />
          {cfg.demo && <DemoStrip state={state} steps={log.steps} canSign={isOwner} busy={busy} ownerCall={ownerCall} setNotice={setNotice} />}
          <div className="grid">
            <Isolated name="Agent">
              <AgentPanel steps={log.steps} online={log.online} decimals={state.token.decimals} symbol={state.token.symbol} />
            </Isolated>
            <Approvals state={state} steps={log.steps} canSign={isOwner} busy={busy} ownerCall={ownerCall} />
          </div>
          <Isolated name="Activity">
            <Activity state={state} refusals={log.refusals} />
          </Isolated>
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
        <span><i className="dot spent" />spent <b className="num">{f(spent)}</b></span>
        <span><i className="dot pending" />pending <b className="num">{f(reserved)}</b></span>
        <span>left <b className="num">{f(remaining)}</b></span>
        <span>limit <b className="num">{f(daily_max)}</b> {state.token.symbol} per UTC day</span>
      </div>
    </div>
  );
}

function VaultPanel({ state, canSign, busy, ownerCall }: { state: VaultState; canSign: boolean; busy: boolean; ownerCall: OwnerCall }) {
  const p = state.config.policy;
  const [withdraw, setWithdraw] = useState("");
  const withdrawBase = useMemo(() => {
    if (!/^\d+(\.\d+)?$/.test(withdraw)) return null;
    const [w, frac = ""] = withdraw.split(".");
    return (BigInt(w!) * 10n ** BigInt(state.token.decimals) + BigInt(frac.padEnd(state.token.decimals, "0").slice(0, state.token.decimals) || "0")).toString();
  }, [withdraw, state.token.decimals]);

  const merchants = state.merchants.map((m) => m.label).join(", ");
  return (
    <section className="panel vault">
      <div className="summary">
        <div className="stat">
          <span className="stat-label">Vault balance</span>
          <span className="stat-value num">{formatAmount(state.balance, state.token.decimals, 4)} <small>{state.token.symbol}</small></span>
          <span className="muted small">on Intents, held by the contract</span>
        </div>
        <div className="stat">
          <span className="stat-label">Per payment</span>
          <span className="stat-value num">{formatAmount(p.per_payment_max, state.token.decimals, 4)}</span>
          <span className="muted small">approval above {formatAmount(p.approval_threshold, state.token.decimals, 4)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Daily limit</span>
          <span className="stat-value num">{formatAmount(p.daily_max, state.token.decimals, 4)}</span>
          <span className="muted small">{state.merchants.length === 0 ? "no merchants allowed" : `pays only: ${merchants}`}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Status</span>
          <span className="stat-value">{p.paused ? <span className="pill bad">Paused</span> : <span className="pill ok">Active</span>}</span>
          {canSign && (
            <button className="ghost" disabled={busy} onClick={() => void ownerCall(p.paused ? "unpause" : "pause", {}, p.paused ? "Unpause" : "Pause")}>
              {p.paused ? "Unpause" : "Pause"}
            </button>
          )}
        </div>
      </div>
      <h3>Today</h3>
      <BudgetBar state={state} />
      <details className="vault-details">
        <summary>Vault details, policy v{p.version} and allowlist</summary>
        <dl className="kv">
          <dt>Vault</dt><dd><code>{cfg.vaultId}</code> (no access keys)</dd>
          <dt>Agent</dt><dd><code>{state.config.agent}</code></dd>
          <dt>Intents</dt><dd><code>{cfg.intentsId}</code></dd>
          <dt>Token</dt><dd><code>{p.token_id}</code></dd>
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
      </details>
    </section>
  );
}

function Approvals({ state, steps, canSign, busy, ownerCall }: { state: VaultState; steps: Step[]; canSign: boolean; busy: boolean; ownerCall: OwnerCall }) {
  const awaiting = state.ops.filter((r) => r.status === "AwaitingApproval");
  const now = BigInt(Date.now()) * 1_000_000n;
  return (
    <section className="panel approvals">
      <h2>Approvals</h2>
      {awaiting.length === 0 && (
        <p className="muted">
          No approval needed. Payments above {formatAmount(state.config.policy.approval_threshold, state.token.decimals, 4)} {state.token.symbol} appear here.
        </p>
      )}
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
          <article key={r.op.op_id} className="card" id={`approval-${r.op.op_id}`} tabIndex={-1}>
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
                <td><span className={`pill ${r.tone}`}>{r.status}</span></td>
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
      <h2>Agent {online ? <span className="pill ok">live</span> : <span className="pill bad">runner offline</span>}</h2>
      {!online && <p className="muted">The agent runner is not reachable; the vault's own data above is still live.</p>}
      {online && recent.length === 0 && <p className="muted">Nothing yet. Start with step 1, Buy a report.</p>}
      <ol className="steps">
        {recent.map((s) => {
          const notes = s.kind === "invoice" ? (s.data as { notes?: string } | undefined)?.notes : undefined;
          return (
            <li key={s.seq} className={`${s.kind}${s.kind === "vault" && /^refused/.test(s.text) ? " refused" : ""}`}>
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

/** A run ends with a delivery, an error, a refusal, a wait for approval, or the parallel summary. */
export function runInFlight(steps: Step[]): boolean {
  const last = steps.at(-1);
  if (!last) return false;
  const mine = steps.filter((s) => s.run === last.run);
  return !mine.some(
    (s) => s.kind === "deliver" || s.kind === "error" || (s.kind === "vault" && /^refused|awaits the owner|\d+ accepted, \d+ refused/.test(s.text)),
  );
}

function DemoStrip({ state, steps, canSign, busy, ownerCall, setNotice }: {
  state: VaultState;
  steps: Step[];
  canSign: boolean;
  busy: boolean;
  ownerCall: OwnerCall;
  setNotice: (n: Notice) => void;
}) {
  const [current, setCurrent] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const inFlight = launching || runInFlight(steps);
  const run = async (n: number, path: string, body: object, label: string) => {
    setCurrent(n);
    setLaunching(true);
    const err = await agentPost(path, body);
    // The runner's first step arrives over SSE within a moment; hold the strip until then.
    setTimeout(() => setLaunching(false), 1500);
    setNotice(err ? { tone: "bad", text: `${label}: ${err}` } : { tone: "ok", text: `${label}: started; watch the Agent panel` });
  };
  const awaiting = state.ops.find((r) => r.status === "AwaitingApproval");
  const milli = 10n ** BigInt(state.token.decimals - 3);
  const focusApproval = () => {
    if (!awaiting) return;
    setCurrent(6);
    const card = document.getElementById(`approval-${awaiting.op.op_id}`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    card?.focus();
  };
  const items: Array<{ n: number; label: string; hint: string; attack?: boolean; disabled?: boolean; onClick: () => void }> = [
    { n: 1, label: "Buy a report", hint: "normal purchase, 0.002", onClick: () => void run(1, "/buy", { task: "Buy near-weekly" }, "Purchase") },
    { n: 2, label: "T1 injected merchant", hint: "hijacked agent obeys the invoice", attack: true, onClick: () => void run(2, "/buy", { task: "Buy near-weekly", compromised: true }, "T1") },
    { n: 3, label: "T2 leaked key", hint: "calls the vault directly", attack: true, onClick: () => void run(3, "/attack/direct-call", {}, "T2") },
    { n: 4, label: "Buy (needs approval)", hint: "0.008, above the threshold", onClick: () => void run(4, "/buy", { task: "Buy intents-deep-dive" }, "Purchase") },
    {
      n: 5,
      label: "T9 tampered approval",
      hint: "app asks the wallet for a different amount",
      attack: true,
      disabled: !canSign || !awaiting || busy,
      onClick: () => {
        if (!awaiting) return;
        setCurrent(5);
        void ownerCall("approve", { op: { ...awaiting.op, amount: (BigInt(awaiting.op.amount) + milli).toString() } }, "T9 tampered approval");
      },
    },
    { n: 6, label: "Approve in wallet", hint: "the real approval, in the Approvals panel", disabled: !awaiting, onClick: focusApproval },
    { n: 7, label: "T5 8 at once", hint: "8 × 0.004 from 8 keys", attack: true, onClick: () => void run(7, "/attack/parallel", { amount: (4n * milli).toString(), count: 8 }, "T5") },
  ];
  return (
    <section className="demo" aria-label="Demo steps">
      <div className="demo-head">
        <span className="demo-label">Demo</span>
        <span className="muted small">Run in order. Steps 5 and 6 need the approval from step 4. {inFlight && <b>Running…</b>}</span>
      </div>
      <ol className="demo-steps">
        {items.map((s) => (
          <li key={s.n} className={current === s.n ? "current" : ""}>
            <button className={s.attack ? "attack" : ""} disabled={s.disabled || (inFlight && s.n !== 6)} onClick={s.onClick}>
              <span className="n">{s.n}</span>
              {s.label}
            </button>
            <span className="hint">{s.hint}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
