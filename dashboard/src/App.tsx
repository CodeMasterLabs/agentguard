import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatUnits, parseUnits } from "@agentguard/sdk/dist/units.js";
import { REASON_TEXT } from "@agentguard/sdk/dist/types.js";
import { actions, getConnector, getVault, getVaultsOf, tokenDecimals, type Network, type PendingSpend, type Vault } from "./near";
import { Icon, Logo, type IconName } from "./icons";
import { Landing } from "./landing";
import { Onboarding } from "./onboarding";
import { Docs } from "./docs";
import { useRoute, type Route } from "./ui";

const params = new URLSearchParams(location.search);
const DEFAULT_CONTRACT = params.get("contract") ?? "guard.cm-agentguard.testnet";
const DEFAULT_NETWORK: Network = params.get("network") === "mainnet" ? "mainnet" : "testnet";
const DEFAULT_VAULT = params.get("vault");
const DEMO = { network: "testnet" as Network, contract: "guard.cm-agentguard.testnet", vault: 6 };
const REFRESH_MS = 5000;

type Toast = { kind: "ok" | "err"; text: string } | null;
type Reason = PendingSpend["reason"];

/** Short labels for the queue; the full sentence from the SDK goes in the tooltip. */
const REASON_LABEL: Partial<Record<Reason, string>> = {
  new_recipient: "New recipient",
  over_approval_threshold: "Above auto-approve",
  oracle_review: "Oracle asked for review",
  needs_attestation: "No risk verdict",
  cross_chain_needs_attestation: "Cross-chain, unverified",
};

function ago(ns: string): string {
  const s = Math.max(0, Math.round((Date.now() - Number(BigInt(ns) / 1_000_000n)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function until(ms: number): string {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** Same JSON value, ignoring formatting. Keys keep the contract's order, so stringify compares. */
function sameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

const symbol = (token: string) => (token === "near" ? "NEAR" : token.split(".")[0].toUpperCase());
/** Grouped thousands, at most 4 decimals: what a person reads, not what the chain stores. */
function pretty(raw: string, decimals: number): string {
  const [i, f = ""] = formatUnits(raw, decimals).split(".");
  const frac = f.slice(0, 4).replace(/0+$/, "");
  return `${BigInt(i).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}
const ratio = (part: bigint, whole: bigint) => (whole > 0n ? Math.min(1, Number((part * 10_000n) / whole) / 10_000) : 0);

export function App() {
  const [network, setNetwork] = useState<Network>(DEFAULT_NETWORK);
  const [contract, setContract] = useState(DEFAULT_CONTRACT);
  const [account, setAccount] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<number | null>(DEFAULT_VAULT && /^\d+$/.test(DEFAULT_VAULT) ? Number(DEFAULT_VAULT) : null);
  const [myVaults, setMyVaults] = useState<number[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [route, go] = useRoute();

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
    const q = new URLSearchParams({ contract, network, ...(vaultId !== null && route === "app" ? { vault: String(vaultId) } : {}) });
    history.replaceState(null, "", `?${q}${location.hash}`);
  }, [contract, network, vaultId, route]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "ok" ? 5000 : 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const walletError = (e: unknown) => setToast({ kind: "err", text: `Wallet: ${(e as Error).message}` });
  const connect = () => getConnector(network).connect().catch(walletError);
  const disconnect = () => getConnector(network).disconnect().then(() => setAccount(null)).catch(walletError);
  const open = (c: string, v: number) => (setContract(c), setVaultId(v), route !== "app" && go("app"));
  const openDemo = () => (setNetwork(DEMO.network), open(DEMO.contract, DEMO.vault));
  const nav: [Route, string][] = [["docs", "Docs"], ["start", "Setup guide"], ["app", "Dashboard"]];
  const skip = (e: React.MouseEvent) => (e.preventDefault(), document.querySelector<HTMLElement>("main")?.focus());

  return (
    <>
      <a className="skip" href="#main" onClick={skip}>Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand btn ghost" style={{ padding: 0, background: "none", height: "auto", color: "var(--text)" }} onClick={() => go("home")} aria-label="AgentGuard home">
            <Logo />
            <b className="hide-sm">AgentGuard</b>
          </button>
          <nav className={`topnav${route === "app" ? " hide-sm" : ""}`} aria-label="Main">
            {nav.map(([r, label]) => (
              <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined} className={r === "app" ? "hide-sm" : r === "start" ? "hide-xs" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          {route === "app" && vaultId !== null && (
            <nav className="crumb" aria-label="Location">
              <span className="sep">/</span>
              <span className="mono" title={contract}>{contract}</span>
              <span className="sep">/</span>
              <span className="num" style={{ color: "var(--text)" }}>Vault {vaultId}</span>
            </nav>
          )}
          <span className="spacer" />
          <div className={`seg${route === "app" || route === "start" ? "" : " hide-md"}`} role="group" aria-label="Network">
            {(["testnet", "mainnet"] as const).map((n) => (
              <button key={n} aria-pressed={network === n} onClick={() => setNetwork(n)}>
                {n === "testnet" ? "Testnet" : "Mainnet"}
              </button>
            ))}
          </div>
          {account ? (
            <div className="account">
              <span className="dot" aria-hidden />
              <span className="mono" title={account}>{account}</span>
              <button className="btn ghost icon-only sm" onClick={disconnect} aria-label="Sign out" title="Sign out">
                <Icon name="logOut" size={15} />
              </button>
            </div>
          ) : (
            <button className="btn" onClick={connect}>
              <Icon name="wallet" />
              <span>Connect<span className="hide-sm"> wallet</span></span>
            </button>
          )}
        </div>
      </header>

      {route === "home" && <Landing onStart={() => go("start")} onDocs={() => go("docs")} onDemo={openDemo} />}
      {route === "docs" && (
        <div className="page wide">
          <Docs contract={contract} onStart={() => go("start")} />
        </div>
      )}
      {route === "start" && (
        <div className="page">
          <Onboarding
            network={network}
            contract={contract}
            account={account}
            onConnect={connect}
            onOpenVault={(v) => open(contract, v)}
            onToast={setToast}
            onDocs={() => go("docs")}
          />
        </div>
      )}
      {route === "app" && (
      <div className="page">
        {vaultId === null ? (
          <Welcome contract={contract} myVaults={myVaults} onOpen={open} onDemo={openDemo} onStart={() => go("start")} />
        ) : (
          <>
            <VaultView
              key={`${network}/${contract}/${vaultId}`}
              network={network}
              contract={contract}
              vaultId={vaultId}
              account={account}
              onToast={setToast}
              switcher={<Switcher contract={contract} vaultId={vaultId} myVaults={myVaults} onOpen={open} />}
            />
          </>
        )}
      </div>
      )}

      <footer className="foot">
        <span className="foot-brand"><Logo size={20} /> AgentGuard · a spending firewall for AI agents on NEAR</span>
        <nav aria-label="Footer">
          <a href="#/docs">Docs</a>
          <a href="#/start">Setup guide</a>
          <a href="#/app">Dashboard</a>
          <a href="https://github.com/CodeMasterLabs/agentguard" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
      </footer>

      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "err" ? "alert" : "status"}>
          <Icon name={toast.kind === "ok" ? "check" : "alert"} size={18} />
          <p>{toast.text}</p>
          <button type="button" className="btn ghost icon-only sm" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- picker

function Picker(p: { contract: string; vaultId?: number | null; myVaults: number[]; onOpen: (contract: string, vault: number) => void; submitLabel?: string }) {
  const [contract, setContract] = useState(p.contract);
  const [vault, setVault] = useState(p.vaultId != null ? String(p.vaultId) : "");
  const valid = /^\d+$/.test(vault.trim()) && contract.trim().length > 1;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) p.onOpen(contract.trim(), Number(vault.trim()));
  };
  return (
    <form className="picker" onSubmit={submit}>
      <label className="field">
        <span>Contract</span>
        <input className="input mono" value={contract} onChange={(e) => setContract(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="field">
        <span>Vault</span>
        <input className="input num" value={vault} onChange={(e) => setVault(e.target.value)} inputMode="numeric" placeholder="0" />
      </label>
      <button className="btn" type="submit" disabled={!valid}>
        {p.submitLabel ?? "Open"} <Icon name="arrowRight" />
      </button>
      {p.myVaults.length > 0 && (
        <div className="mine">
          <span>Your vaults</span>
          {p.myVaults.map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={v === p.vaultId} onClick={() => p.onOpen(contract.trim(), v)}>
              #{v}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function Switcher(p: { contract: string; vaultId: number; myVaults: number[]; onOpen: (contract: string, vault: number) => void }) {
  return (
    <details className="switcher">
      <summary className="btn secondary">
        Switch vault <Icon name="chevronDown" size={14} />
      </summary>
      <div className="panel switcher-pop">
        <div className="panel-body">
          <Picker contract={p.contract} vaultId={p.vaultId} myVaults={p.myVaults} onOpen={p.onOpen} />
        </div>
      </div>
    </details>
  );
}

function Welcome(p: { contract: string; myVaults: number[]; onOpen: (contract: string, vault: number) => void; onDemo: () => void; onStart: () => void }) {
  return (
    <main id="vault" tabIndex={-1} className="welcome">
      <div>
        <span className="badge ok"><span className="pulse" /> Live on NEAR testnet</span>
        <h1 style={{ marginTop: 18 }}>
          Your agents can spend.
          <br />
          <em>You decide how much.</em>
        </h1>
        <p className="lede">
          Every payment an AI agent asks for is checked against your vault's policy and a risk oracle running in a TEE.
          It goes through, waits here for you, or is refused.
        </p>
        <div className="cta">
          <button className="btn lg" onClick={p.onDemo}>
            Open the demo vault <Icon name="arrowRight" />
          </button>
          <button className="btn lg secondary" onClick={p.onStart}>
            Create your own
          </button>
        </div>
        <div className="points">
          <div className="point">
            <b><Icon name="shieldCheck" /> Hard limits</b>
            Per-payment caps, period budgets and rate limits, enforced on-chain.
          </div>
          <div className="point">
            <b><Icon name="scan" /> Injection-aware</b>
            A TEE oracle signs a verdict on the text that made the agent pay.
          </div>
          <div className="point">
            <b><Icon name="power" /> One-tap kill switch</b>
            Pause the agent from any key, then review what it wanted.
          </div>
        </div>
      </div>
      <section className="panel" aria-labelledby="open-h">
        <div className="panel-head">
          <h2 id="open-h">Open a vault</h2>
          <p>No wallet needed to look</p>
        </div>
        <div className="panel-body">
          <Picker contract={p.contract} myVaults={p.myVaults} onOpen={p.onOpen} submitLabel="Open vault" />
          <p className="hint">Connect the owner's wallet to approve, pause or withdraw.</p>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------- vault

function VaultView(p: { network: Network; contract: string; vaultId: number; account: string | null; onToast: (t: Toast) => void; switcher: ReactNode }) {
  const [vault, setVault] = useState<Vault | null | undefined>(undefined);
  // null: the token's metadata could not be read, so amounts are shown in base units.
  const [decimals, setDecimals] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await getVault(p.network, p.contract, p.vaultId);
      // Decimals first, then both together: never render an amount with the wrong scale.
      const tokens = v ? [...new Set([...Object.keys(v.policy.tokens), ...Object.keys(v.balances)])] : [];
      const entries = await Promise.all(tokens.map(async (t) => [t, await tokenDecimals(p.network, t).catch(() => null)] as const));
      setDecimals(Object.fromEntries(entries));
      setVault(v);
      setError(null);
      setUpdatedAt(Date.now());
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

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await f();
      p.onToast({ kind: "ok", text: `${label}: done.` });
      await load();
    } catch (e) {
      p.onToast({ kind: "err", text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  // Only a first load that fails replaces the view; later failures keep the last data.
  if (vault === undefined && error) {
    return (
      <div className="panel empty err" role="alert">
        <span className="bubble"><Icon name="alert" size={20} /></span>
        <b>Could not read vault #{p.vaultId}</b>
        <p>{error}</p>
        {p.switcher}
      </div>
    );
  }
  if (vault === undefined) return <Skeleton />;
  if (vault === null) {
    return (
      <div className="panel empty">
        <span className="bubble"><Icon name="inbox" size={20} /></span>
        <b>No vault #{p.vaultId} here</b>
        <p>There is no vault with this id on {p.contract}. Check the id, or switch network.</p>
        {p.switcher}
      </div>
    );
  }

  const isOwner = p.account === vault.owner;
  const can = isOwner && !busy;
  const fmt = (token: string, raw: string): [string, string] => {
    const d = decimals[token];
    return d == null ? [raw, `base units of ${token}`] : [pretty(raw, d), symbol(token)];
  };
  const fmtText = (token: string, raw: string) => fmt(token, raw).join(" ");

  const tokens = [...new Set([...Object.keys(vault.policy.tokens), ...Object.keys(vault.balances)])];
  const primary = vault.policy.tokens.near ? "near" : (Object.keys(vault.policy.tokens)[0] ?? "near");
  // The contract rolls its windows only when the agent next asks; show what that request
  // will see, not the totals of a window that already ended.
  const now = Date.now();
  const periodEnds = Number(BigInt(vault.usage.period_start) / 1_000_000n) + vault.policy.period_secs * 1000;
  const periodOver = now >= periodEnds;
  const hourOver = now >= Number(BigInt(vault.usage.hour_start) / 1_000_000n) + 3_600_000;
  const spentNow = (t: string) => (periodOver ? "0" : vault.usage.spent[t] ?? "0");
  const hourReqs = hourOver ? 0 : vault.usage.hour_requests;

  const limits = vault.policy.tokens[primary];
  const spentShare = limits ? ratio(BigInt(spentNow(primary)), BigInt(limits.period_limit)) : 0;
  const reqShare = ratio(BigInt(hourReqs), BigInt(vault.policy.max_requests_per_hour));
  const tone = (r: number) => (r >= 1 ? "danger" : r >= 0.8 ? "warn" : "");
  const [balance, balanceUnit] = fmt(primary, vault.balances[primary] ?? "0");
  const otherTokens = tokens.filter((t) => t !== primary && (vault.balances[t] ?? "0") !== "0").length;

  return (
    <main id="vault" tabIndex={-1} className="col">
      {error && (
        <div className="banner warn" role="status">
          <Icon name="alert" />
          <p>Could not refresh ({error}). Showing data from {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "earlier"}.</p>
        </div>
      )}

      <section className="vault-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">Spending vault</span>
          <h1>
            <span className="num">Vault #{p.vaultId}</span>
            {vault.paused ? (
              <span className="badge danger"><Icon name="shieldOff" size={13} /> Paused</span>
            ) : (
              <span className="badge ok"><span className="pulse" /> Guarding</span>
            )}
          </h1>
          <div className="facts">
            <span className="fact">
              <Icon name="user" size={14} /> Owner <span className="mono" title={vault.owner}>{vault.owner}</span>
              {isOwner && <span className="you">you</span>}
            </span>
            <span className="fact">
              <Icon name="bot" size={14} /> Agent{" "}
              {vault.agent ? <span className="mono" title={vault.agent}>{vault.agent}</span> : <em className="muted">none, revoked</em>}
              {vault.agent && isOwner && (
                <button className="linkish" disabled={!!busy} onClick={() => run("Revoke agent", () => actions.setAgent(p.network, p.contract, p.vaultId, null))}>
                  {busy === "Revoke agent" ? "revoking…" : "revoke"}
                </button>
              )}
            </span>
            <span className="fact">
              <Icon name="scan" size={14} /> Oracle{" "}
              {vault.oracle_pk ? <span className="mono" title={vault.oracle_pk}>{vault.oracle_pk.slice(0, 10)}…{vault.oracle_pk.slice(-6)}</span> : <em className="muted">none</em>}
            </span>
          </div>
        </div>
        <div className="head-actions">
          <div className="row" style={{ flexWrap: "nowrap" }}>
          {p.switcher}
          {vault.paused ? (
            <button className="btn lg" disabled={!can} onClick={() => run("Resume", () => actions.unpause(p.network, p.contract, p.vaultId))}>
              <Icon name="play" /> {busy === "Resume" ? "Resuming…" : "Resume agent"}
            </button>
          ) : (
            <button className="btn danger lg" disabled={!can} onClick={() => run("Kill switch", () => actions.pause(p.network, p.contract, p.vaultId))}>
              <Icon name="power" /> {busy === "Kill switch" ? "Pausing…" : "Kill switch"}
            </button>
          )}
          </div>
          {!isOwner && <small>{p.account ? "Only the owner can act on this vault." : "Connect the owner's wallet to act."}</small>}
        </div>
      </section>

      {vault.paused && (
        <div className="banner danger" role="status">
          <Icon name="shieldOff" size={18} />
          <p>
            <b>Every spend is refused while paused.</b> Review what is waiting below, then resume when you are ready. Withdrawals still work.
          </p>
        </div>
      )}

      <section className="stats" aria-label="Vault at a glance">
        <Stat icon="wallet" label="Balance" value={balance} unit={balanceUnit} sub={otherTokens ? `+ ${otherTokens} other token${otherTokens > 1 ? "s" : ""}` : "Held by the vault, not the agent"} />
        <Stat
          icon="clock"
          label="Spent this period"
          value={limits ? fmt(primary, spentNow(primary))[0] : "—"}
          unit={limits ? `of ${fmtText(primary, limits.period_limit)}` : ""}
          meter={limits ? spentShare : undefined}
          tone={tone(spentShare)}
          sub={periodOver ? "Window ended; the next request starts a new one" : `Resets in ${until(periodEnds)}`}
        />
        <Stat
          icon="bot"
          label="Requests this hour"
          value={String(hourReqs)}
          unit={`of ${vault.policy.max_requests_per_hour}`}
          meter={reqShare}
          tone={tone(reqShare)}
          sub={vault.policy.pause_on_rate_limit ? "Hitting the limit pauses the vault" : "Over the limit, requests are refused"}
        />
        <Stat
          icon="inbox"
          label="Waiting for you"
          value={String(vault.pending.length)}
          unit={vault.pending.length === 1 ? "payment" : "payments"}
          attention={vault.pending.length > 0}
          sub={`${vault.nonce} requests since the vault was created`}
        />
      </section>

      <div className="grid">
        <div className="col">
          <section className="panel" aria-labelledby="queue-h">
            <div className="panel-head">
              <h2 id="queue-h">
                Approval queue {vault.pending.length > 0 && <span className="count">{vault.pending.length}</span>}
              </h2>
              <p>Newest first</p>
            </div>
            {vault.pending.length === 0 ? (
              <div className="empty">
                <span className="bubble"><Icon name="shieldCheck" size={20} /></span>
                <b>Nothing is waiting</b>
                <p>Payments the policy cannot decide on its own, like a new recipient or a large amount, appear here for you to approve.</p>
              </div>
            ) : (
              <ul className="queue">
                {[...vault.pending].reverse().map((s) => (
                  <PendingRow
                    key={s.id}
                    s={s}
                    fmt={fmt}
                    disabled={!can}
                    busy={busy}
                    onApprove={() => run(`Approve #${s.id}`, () => actions.approve(p.network, p.contract, p.vaultId, s.id))}
                    onReject={() => run(`Reject #${s.id}`, () => actions.reject(p.network, p.contract, p.vaultId, s.id))}
                    onCopy={(t) =>
                      navigator.clipboard
                        ?.writeText(t)
                        .then(() => p.onToast({ kind: "ok", text: "Address copied." }))
                        .catch(() => p.onToast({ kind: "err", text: "Could not copy the address." }))
                    }
                  />
                ))}
              </ul>
            )}
          </section>

          <PolicyEditor vault={vault} disabled={!can} onSave={(policy) => run("Update policy", () => actions.updatePolicy(p.network, p.contract, p.vaultId, policy))} />
        </div>

        <div className="col">
          <Guardrails vault={vault} fmtText={fmtText} />
          <Withdraw
            tokens={tokens}
            balances={vault.balances}
            decimals={decimals}
            fmtText={fmtText}
            disabled={!can}
            onWithdraw={(token, amount) => run("Withdraw", () => actions.withdraw(p.network, p.contract, p.vaultId, token, amount))}
          />
        </div>
      </div>
    </main>
  );
}

function Stat(p: { icon: IconName; label: string; value: string; unit?: string; sub?: string; meter?: number; tone?: string; attention?: boolean }) {
  return (
    <div className={`panel stat${p.attention ? " attention" : ""}`}>
      <span className="label"><Icon name={p.icon} size={14} /> {p.label}</span>
      <span className="value">
        <span className="trunc" title={p.value}>{p.value}</span>
        {p.unit && <small className="trunc">{p.unit}</small>}
      </span>
      {p.meter !== undefined && (
        <div className={`meter ${p.tone ?? ""}`} role="meter" aria-label={p.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.meter * 100)}>
          <i style={{ width: `${Math.max(p.meter * 100, p.meter > 0 ? 2 : 0)}%` }} />
        </div>
      )}
      {p.sub && <span className="sub">{p.sub}</span>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="col" aria-busy="true" aria-label="Loading vault">
      <div className="col" style={{ gap: 12 }}>
        <div className="sk" style={{ width: 90, height: 12 }} />
        <div className="sk" style={{ width: 260, height: 30 }} />
        <div className="sk" style={{ width: "min(520px, 100%)", height: 14 }} />
      </div>
      <div className="stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel stat">
            <div className="sk" style={{ width: 110, height: 12 }} />
            <div className="sk" style={{ width: 140, height: 26 }} />
            <div className="sk" style={{ width: "100%", height: 6 }} />
          </div>
        ))}
      </div>
      <div className="grid">
        <div className="panel" style={{ height: 280 }} />
        <div className="panel" style={{ height: 280 }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- queue

function PendingRow(p: {
  s: PendingSpend;
  fmt: (t: string, raw: string) => [string, string];
  disabled: boolean;
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
  onCopy: (text: string) => void;
}) {
  const r = p.s.request;
  const [amount, unit] = p.fmt(r.token, r.amount);
  const crossChain = !r.recipient.startsWith("near:");
  const i = r.recipient.indexOf(":");
  const [chain, address] = [r.recipient.slice(0, i), r.recipient.slice(i + 1)];
  return (
    <li className="req">
      <div className="req-main">
        <div className="req-top">
          <span className="req-amount">{amount}<small>{unit}</small></span>
          <span className="badge warn" title={REASON_TEXT[p.s.reason]}>
            <Icon name="clock" size={12} /> {REASON_LABEL[p.s.reason] ?? p.s.reason.replaceAll("_", " ")}
          </span>
        </div>
        <div className="req-to">
          <span>to</span>
          <span className="addr" title={r.recipient}>
            <span className="mono">{crossChain ? `${chain} · ${address}` : address}</span>
            <button onClick={() => p.onCopy(address)} aria-label={`Copy ${address}`}><Icon name="copy" size={13} /></button>
          </span>
        </div>
        {r.purpose ? <p className="req-purpose">{r.purpose}</p> : <p className="muted">No purpose given</p>}
        <div className="req-meta">
          <span className="num">#{p.s.id}</span>
          <span className="sep" aria-hidden />
          <span>{ago(p.s.created_at)}</span>
          {crossChain && (
            <>
              <span className="sep" aria-hidden />
              <span>via deposit <span className="mono">{r.pay_to.slice(0, 8)}…</span></span>
            </>
          )}
        </div>
      </div>
      <div className="req-actions">
        <button className="btn secondary" disabled={p.disabled} onClick={p.onReject} aria-label={`Reject payment #${p.s.id}`}>
          <Icon name="x" /> {p.busy === `Reject #${p.s.id}` ? "Rejecting…" : "Reject"}
        </button>
        <button className="btn" disabled={p.disabled} onClick={p.onApprove} aria-label={`Approve payment #${p.s.id}`}>
          <Icon name="check" /> {p.busy === `Approve #${p.s.id}` ? "Approving…" : "Approve"}
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- side panels

function Rule(p: { label: string; children: ReactNode }) {
  return (
    <li className="rule">
      <span>{p.label}</span>
      <b>{p.children}</b>
    </li>
  );
}

const onOff = (on: boolean) => (on ? <span className="on"><Icon name="check" size={13} /> On</span> : <span className="off">Off</span>);

function Guardrails(p: { vault: Vault; fmtText: (t: string, raw: string) => string }) {
  const pol = p.vault.policy;
  const hours = pol.period_secs / 3600;
  const period = Number.isInteger(hours / 24) ? (hours === 24 ? "day" : `${hours / 24} days`) : `${+hours.toFixed(2)} h`;
  return (
    <section className="panel" aria-labelledby="rules-h">
      <div className="panel-head">
        <h2 id="rules-h"><Icon name="shieldCheck" /> Guardrails</h2>
        <p>Enforced on-chain</p>
      </div>
      <div className="panel-body">
        {Object.entries(pol.tokens).map(([t, l]) => (
          <div key={t} style={{ marginBottom: 22 }}>
            <div className="token-sym"><i>{symbol(t).slice(0, 1)}</i> {symbol(t)}</div>
            <ul className="rules">
              <Rule label="Max per payment">{p.fmtText(t, l.max_per_tx)}</Rule>
              <Rule label={`Budget per ${period}`}>{p.fmtText(t, l.period_limit)}</Rule>
              <Rule label="Auto-approved up to">{p.fmtText(t, l.approval_threshold)}</Rule>
              <Rule label="Risk verdict from">{l.attestation_threshold ? p.fmtText(t, l.attestation_threshold) : <span className="off">Never required</span>}</Rule>
            </ul>
          </div>
        ))}
        <div className="eyebrow section-label">Recipients & behaviour</div>
        <ul className="rules">
          <Rule label="New recipients need approval">{onOff(pol.new_recipient_needs_approval)}</Rule>
          <Rule label="Requests per hour">{pol.max_requests_per_hour}</Rule>
          <Rule label="Pause on rate limit">{onOff(pol.pause_on_rate_limit)}</Rule>
          <Rule label="Allow list">
            {pol.allowed_recipients ? (
              <span className="tags">{pol.allowed_recipients.map((r) => <span key={r} className="tag allow" title={r}>{r}</span>)}</span>
            ) : (
              <span className="off">Anyone</span>
            )}
          </Rule>
          <Rule label="Deny list">
            {pol.denied_recipients.length ? (
              <span className="tags">{pol.denied_recipients.map((r) => <span key={r} className="tag" title={r}>{r}</span>)}</span>
            ) : (
              <span className="off">Empty</span>
            )}
          </Rule>
        </ul>
      </div>
    </section>
  );
}

function Withdraw(p: {
  tokens: string[];
  balances: Record<string, string>;
  decimals: Record<string, number | null>;
  fmtText: (t: string, raw: string) => string;
  disabled: boolean;
  onWithdraw: (token: string, raw: string) => void;
}) {
  const [token, setToken] = useState(p.tokens[0] ?? "near");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const d = p.decimals[token];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    try {
      setErr(null);
      if (d == null) throw new Error(`Could not read the decimals of ${token}; withdraw it with the CLI.`);
      p.onWithdraw(token, parseUnits(amount, d));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="panel" aria-labelledby="wd-h">
      <div className="panel-head">
        <h2 id="wd-h"><Icon name="download" /> Withdraw</h2>
        <p>To the owner, even while paused</p>
      </div>
      <form className="panel-body withdraw" onSubmit={submit}>
        <label className="field">
          <span>Token</span>
          <select className="select" value={token} onChange={(e) => setToken(e.target.value)}>
            {p.tokens.map((t) => <option key={t} value={t}>{symbol(t)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Amount</span>
          <span className="amount-field">
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />
            {d != null && (
              <button type="button" className="max" onClick={() => setAmount(formatUnits(p.balances[token] ?? "0", d))}>MAX</button>
            )}
          </span>
        </label>
        <span className="hint" style={{ gridColumn: "1 / -1" }}>Available: {p.fmtText(token, p.balances[token] ?? "0")}</span>
        {err && <p className="form-err"><Icon name="alert" size={14} /> {err}</p>}
        <button className="btn secondary" type="submit" disabled={p.disabled || !amount}>Withdraw</button>
      </form>
    </section>
  );
}

function PolicyEditor(p: { vault: Vault; disabled: boolean; onSave: (policy: Vault["policy"]) => void }) {
  const current = useMemo(() => JSON.stringify(p.vault.policy, null, 2), [p.vault.policy]);
  // `base` is what the owner started editing from. Polling never overwrites their edits;
  // if the policy changed on chain meanwhile, they are told instead.
  const [base, setBase] = useState(current);
  const [text, setText] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  const dirty = text !== base;
  useEffect(() => {
    // Not editing, or the owner's own save just landed: follow the chain.
    if (!dirty || (text.trim() && sameJson(text, current))) {
      setBase(current);
      setText(current);
    }
  }, [current, dirty, text]);
  const reset = () => (setBase(current), setText(current), setErr(null));
  return (
    <details className="panel json">
      <summary>
        <h2><Icon name="code" /> Edit policy as JSON</h2>
        <span className="row" style={{ gap: 10 }}>
          {dirty && <span className="badge warn">Unsaved</span>}
          <Icon name="chevronDown" size={16} />
        </span>
      </summary>
      <div className="json-body">
        <p className="hint">The exact policy the contract enforces. Saving asks your wallet to sign one transaction.</p>
        <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={16} aria-label="Policy JSON" />
        {dirty && base !== current && <p className="form-err"><Icon name="alert" size={14} /> The policy changed on chain while you were editing. Reset to see it.</p>}
        {err && <p className="form-err"><Icon name="alert" size={14} /> {err}</p>}
        <div className="row">
          <button
            className="btn"
            disabled={p.disabled || !dirty}
            onClick={() => {
              try {
                setErr(null);
                p.onSave(JSON.parse(text));
              } catch (e) {
                setErr(`Not valid JSON: ${(e as Error).message}`);
              }
            }}
          >
            Save policy
          </button>
          <button className="btn ghost" disabled={!dirty && base === current} onClick={reset}>Reset</button>
        </div>
      </div>
    </details>
  );
}
