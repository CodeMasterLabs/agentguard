import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "@agentguard/sdk/dist/units.js";
import { REASON_TEXT } from "@agentguard/sdk/dist/types.js";
import { actions, getConnector, getVault, getVaultsOf, tokenDecimals, type Network, type PendingSpend, type Vault } from "./near";

const params = new URLSearchParams(location.search);
const DEFAULT_CONTRACT = params.get("contract") ?? "guard.cm-agentguard.testnet";
const DEFAULT_NETWORK: Network = params.get("network") === "mainnet" ? "mainnet" : "testnet";
const DEFAULT_VAULT = params.get("vault");
const REFRESH_MS = 5000;

type Toast = { kind: "ok" | "err"; text: string } | null;

function ago(ns: string): string {
  const s = Math.max(0, Math.round((Date.now() - Number(BigInt(ns) / 1_000_000n)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const short = (s: string, n = 10) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

export function App() {
  const [network, setNetwork] = useState<Network>(DEFAULT_NETWORK);
  const [contract, setContract] = useState(DEFAULT_CONTRACT);
  const [contractInput, setContractInput] = useState(DEFAULT_CONTRACT);
  const [account, setAccount] = useState<string | null>(null);
  const [vaultInput, setVaultInput] = useState(DEFAULT_VAULT ?? "");
  const [vaultId, setVaultId] = useState<number | null>(DEFAULT_VAULT ? Number(DEFAULT_VAULT) : null);
  const [myVaults, setMyVaults] = useState<number[]>([]);
  const [toast, setToast] = useState<Toast>(null);

  // Wallet: restore a previous session, then follow sign-in and sign-out.
  useEffect(() => {
    const c = getConnector(network);
    const onIn = (t: { accounts: { accountId: string }[] }) => setAccount(t.accounts[0]?.accountId ?? null);
    const onOut = () => setAccount(null);
    c.on("wallet:signIn", onIn);
    c.on("wallet:signOut", onOut);
    c.getConnectedWallet().then((w) => setAccount(w.accounts[0]?.accountId ?? null)).catch(() => setAccount(null));
    return () => {
      c.off?.("wallet:signIn", onIn);
      c.off?.("wallet:signOut", onOut);
    };
  }, [network]);

  useEffect(() => {
    if (!account) return setMyVaults([]);
    getVaultsOf(network, contract, account).then(setMyVaults).catch(() => setMyVaults([]));
  }, [account, network, contract]);

  useEffect(() => {
    const q = new URLSearchParams({ contract, network, ...(vaultId !== null ? { vault: String(vaultId) } : {}) });
    history.replaceState(null, "", `?${q}`);
  }, [contract, network, vaultId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "ok" ? 5000 : 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const connect = async () => {
    try {
      await getConnector(network).connect();
    } catch (e) {
      setToast({ kind: "err", text: `Wallet: ${(e as Error).message}` });
    }
  };

  return (
    <div className="app">
      <a className="skip" href="#vault">Skip to vault</a>
      <header>
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <h1>AgentGuard</h1>
            <p>What your AI agents may spend, and what they asked for.</p>
          </div>
        </div>
        <div className="wallet">
          <select value={network} onChange={(e) => setNetwork(e.target.value as Network)} aria-label="Network">
            <option value="testnet">testnet</option>
            <option value="mainnet">mainnet</option>
          </select>
          {account ? (
            <button className="ghost" onClick={() => getConnector(network).disconnect().then(() => setAccount(null))} title="Sign out">
              {short(account, 14)} ✕
            </button>
          ) : (
            <button onClick={connect}>Connect wallet</button>
          )}
        </div>
      </header>

      <form
        className="picker"
        onSubmit={(e) => {
          e.preventDefault();
          setContract(contractInput.trim());
          if (/^\d+$/.test(vaultInput)) setVaultId(Number(vaultInput));
        }}
      >
        <label className="grow">
          Contract
          <input value={contractInput} onChange={(e) => setContractInput(e.target.value)} spellCheck={false} />
        </label>
        <div className="open">
          <label>
            Vault
            <input value={vaultInput} onChange={(e) => setVaultInput(e.target.value)} inputMode="numeric" placeholder="0" />
          </label>
          <button type="submit">Open</button>
        </div>
        {myVaults.length > 0 && (
          <div className="mine">
            <span>Your vaults</span>
            {myVaults.map((v) => (
              <button key={v} type="button" aria-pressed={v === vaultId} className={v === vaultId ? "chip on" : "chip"} onClick={() => (setVaultId(v), setVaultInput(String(v)))}>
                #{v}
              </button>
            ))}
          </div>
        )}
      </form>

      {vaultId === null ? (
        <p className="empty">Open a vault to see its balances, policy and the payments waiting for approval. No wallet needed to look.</p>
      ) : (
        <VaultView key={`${network}/${contract}/${vaultId}`} network={network} contract={contract} vaultId={vaultId} account={account} onToast={setToast} />
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "err" ? "alert" : "status"}>
          <span>{toast.text}</span>
          <button type="button" className="ghost" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

function VaultView(p: { network: Network; contract: string; vaultId: number; account: string | null; onToast: (t: Toast) => void }) {
  const [vault, setVault] = useState<Vault | null | undefined>(undefined);
  const [decimals, setDecimals] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await getVault(p.network, p.contract, p.vaultId);
      setVault(v);
      setError(null);
      setUpdatedAt(Date.now());
      if (v) {
        const tokens = Object.keys(v.policy.tokens).concat(Object.keys(v.balances));
        const entries = await Promise.all([...new Set(tokens)].map(async (t) => [t, await tokenDecimals(p.network, t).catch(() => 0)] as const));
        setDecimals(Object.fromEntries(entries));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [p.network, p.contract, p.vaultId]);

  // Poll while the tab is visible; refresh at once when it comes back.
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), REFRESH_MS);
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load]);

  const isOwner = !!vault && p.account === vault.owner;
  const fmt = (token: string, raw: string) => `${formatUnits(raw, decimals[token] ?? 0)} ${token === "near" ? "NEAR" : token}`;

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await f();
      p.onToast({ kind: "ok", text: `${label}: done` });
      await load();
    } catch (e) {
      p.onToast({ kind: "err", text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  // Only a first load that fails replaces the view; later failures keep the last data.
  if (vault === undefined && error) return <p className="empty err" role="alert">Could not read vault #{p.vaultId} on {p.contract}: {error}</p>;
  if (vault === undefined) return <p className="empty" aria-busy="true">Loading vault #{p.vaultId}…</p>;
  if (vault === null) return <p className="empty">There is no vault #{p.vaultId} on {p.contract}.</p>;

  const tokens = [...new Set([...Object.keys(vault.policy.tokens), ...Object.keys(vault.balances)])];
  // The contract rolls its windows only when the agent next asks; show what that request
  // will see, not the totals of a window that already ended.
  const now = Date.now();
  const periodEnds = Number(BigInt(vault.usage.period_start) / 1_000_000n) + vault.policy.period_secs * 1000;
  const periodOver = now >= periodEnds;
  const hourOver = now >= Number(BigInt(vault.usage.hour_start) / 1_000_000n) + 3_600_000;
  const spentNow = (t: string) => (periodOver ? "0" : vault.usage.spent[t] ?? "0");

  return (
    <main id="vault" tabIndex={-1}>
      {error && (
        <p className="stale" role="status">
          Could not refresh ({error}). Showing data from {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "earlier"}.
        </p>
      )}
      <section className={`status ${vault.paused ? "paused" : "live"}`}>
        <div>
          <span className="pill">{vault.paused ? "Paused" : "Active"}</span>
          <h2>Vault #{p.vaultId}</h2>
          <dl>
            <dt>Owner</dt>
            <dd>{vault.owner}{isOwner && " (you)"}</dd>
            <dt>Agent</dt>
            <dd>{vault.agent ?? <em>none, revoked</em>}</dd>
            <dt>Risk oracle</dt>
            <dd title={vault.oracle_pk ?? ""}>{vault.oracle_pk ? short(vault.oracle_pk, 12) : <em>none: spends needing a verdict wait for you</em>}</dd>
            <dt>Requests</dt>
            <dd>{vault.nonce} so far, {hourOver ? 0 : vault.usage.hour_requests} this hour (limit {vault.policy.max_requests_per_hour})</dd>
          </dl>
        </div>
        <div className="kill">
          {vault.paused ? (
            <button disabled={!isOwner || !!busy} onClick={() => run("Resume", () => actions.unpause(p.network, p.contract, p.vaultId))}>
              {busy === "Resume" ? "Resuming…" : "Resume agent"}
            </button>
          ) : (
            <button className="danger" disabled={!isOwner || !!busy} onClick={() => run("Kill switch", () => actions.pause(p.network, p.contract, p.vaultId))}>
              {busy === "Kill switch" ? "Pausing…" : "Kill switch"}
            </button>
          )}
          {!isOwner && <small>{p.account ? "Only the owner can act on this vault." : "Connect the owner's wallet to act."}</small>}
        </div>
      </section>

      <section>
        <h3>Waiting for you {vault.pending.length > 0 && <span className="count">{vault.pending.length}</span>}</h3>
        {vault.pending.length === 0 ? (
          <p className="muted">Nothing is waiting. Spends the policy cannot decide alone show up here.</p>
        ) : (
          <ul className="pending">
            {[...vault.pending].reverse().map((s) => (
              <PendingRow key={s.id} s={s} fmt={fmt} disabled={!isOwner || !!busy} busy={busy}
                onApprove={() => run(`Approve #${s.id}`, () => actions.approve(p.network, p.contract, p.vaultId, s.id))}
                onReject={() => run(`Reject #${s.id}`, () => actions.reject(p.network, p.contract, p.vaultId, s.id))} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Balances and limits</h3>
        <p className="muted">{periodOver ? "The last period has ended: the next request starts a new one." : `Period resets ${new Date(periodEnds).toLocaleString()}.`}</p>
        <div className="tokens">
          {tokens.map((t) => {
            const l = vault.policy.tokens[t];
            const spent = spentNow(t);
            const pct = l ? Math.min(100, Number((BigInt(spent) * 1000n) / (BigInt(l.period_limit) || 1n)) / 10) : 0;
            return (
              <article key={t} className="token">
                <header>
                  <strong>{t === "near" ? "NEAR" : t}</strong>
                  <span>{fmt(t, vault.balances[t] ?? "0")}</span>
                </header>
                {l ? (
                  <>
                    <div className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${t} spent this period`}>
                      <div style={{ width: `${pct}%` }} />
                    </div>
                    <small>{fmt(t, spent)} of {fmt(t, l.period_limit)} spent this period</small>
                    <ul className="limits">
                      <li>Max per payment <b>{fmt(t, l.max_per_tx)}</b></li>
                      <li>Auto-approved up to <b>{fmt(t, l.approval_threshold)}</b></li>
                      <li>Risk verdict from <b>{l.attestation_threshold ? fmt(t, l.attestation_threshold) : "never required"}</b></li>
                    </ul>
                  </>
                ) : (
                  <small className="muted">Not in the policy: the agent cannot spend it.</small>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="two">
        <PolicyEditor vault={vault} disabled={!isOwner || !!busy}
          onSave={(policy) => run("Update policy", () => actions.updatePolicy(p.network, p.contract, p.vaultId, policy))} />
        <Withdraw tokens={tokens} decimals={decimals} disabled={!isOwner || !!busy}
          onWithdraw={(token, amount) => run("Withdraw", () => actions.withdraw(p.network, p.contract, p.vaultId, token, amount))} />
      </section>
    </main>
  );
}

function PendingRow(p: { s: PendingSpend; fmt: (t: string, raw: string) => string; disabled: boolean; busy: string | null; onApprove: () => void; onReject: () => void }) {
  const r = p.s.request;
  const viaDeposit = !r.recipient.startsWith("near:");
  return (
    <li>
      <div className="what">
        <div className="amount">{p.fmt(r.token, r.amount)}</div>
        <div>
          to <code>{r.recipient}</code>
          {viaDeposit && <small> via deposit {short(r.pay_to, 8)}</small>}
        </div>
        <q>{r.purpose || "no purpose given"}</q>
        <small className="why">
          #{p.s.id} · {REASON_TEXT[p.s.reason]} · {ago(p.s.created_at)}
        </small>
      </div>
      <div className="act">
        <button disabled={p.disabled} onClick={p.onApprove} aria-label={`Approve payment #${p.s.id}`}>
          {p.busy === `Approve #${p.s.id}` ? "Approving…" : "Approve"}
        </button>
        <button className="ghost" disabled={p.disabled} onClick={p.onReject} aria-label={`Reject payment #${p.s.id}`}>
          {p.busy === `Reject #${p.s.id}` ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </li>
  );
}

function PolicyEditor(p: { vault: Vault; disabled: boolean; onSave: (policy: Vault["policy"]) => void }) {
  const current = useMemo(() => JSON.stringify(p.vault.policy, null, 2), [p.vault.policy]);
  const [text, setText] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(current), [current]);
  return (
    <article className="card">
      <h3>Policy</h3>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={14} aria-label="Policy JSON" />
      {err && <small className="err">{err}</small>}
      <div className="row">
        <button disabled={p.disabled || text === current} onClick={() => {
          try {
            setErr(null);
            p.onSave(JSON.parse(text));
          } catch (e) {
            setErr(`Not valid JSON: ${(e as Error).message}`);
          }
        }}>Save policy</button>
        <button className="ghost" disabled={text === current} onClick={() => setText(current)}>Reset</button>
      </div>
    </article>
  );
}

function Withdraw(p: { tokens: string[]; decimals: Record<string, number>; disabled: boolean; onWithdraw: (token: string, raw: string) => void }) {
  const [token, setToken] = useState(p.tokens[0] ?? "near");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <article className="card">
      <h3>Withdraw</h3>
      <p className="muted">Back to the owner. Works while paused.</p>
      <div className="row">
        <select value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token">
          {p.tokens.map((t) => <option key={t} value={t}>{t === "near" ? "NEAR" : t}</option>)}
        </select>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5" inputMode="decimal" aria-label="Amount" />
      </div>
      {err && <small className="err">{err}</small>}
      <button disabled={p.disabled || !amount} onClick={() => {
        try {
          setErr(null);
          p.onWithdraw(token, parseUnits(amount, p.decimals[token] ?? 24));
        } catch (e) {
          setErr((e as Error).message);
        }
      }}>Withdraw</button>
    </article>
  );
}
