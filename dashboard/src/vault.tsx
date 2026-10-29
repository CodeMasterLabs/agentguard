// The dashboard route: the vault picker and one vault's page. Loaded on first visit to #/app,
// so the landing page, docs and setup guide never download it.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from "react";
import { formatUnits, parseUnits } from "@agentguard/sdk/dist/units.js";
import { REASON_TEXT } from "@agentguard/sdk/dist/types.js";
import { actions, getVault, tokenDecimals, type Network, type PendingSpend, type Vault } from "./near";
import { getActivity, type Activity, type ActivityEvent } from "./activity";
import { Icon, Logo, type IconName } from "./icons";
import { CodeBlock } from "./ui";
import { ownerOps } from "./cli";

export type Toast = { kind: "ok" | "err"; text: string } | null;

/** The #/app page: pick a vault, or show the open one. */
export function AppPage(p: {
  network: Network;
  contract: string;
  vaultId: number | null;
  account: string | null;
  myVaults: number[];
  onOpen: (contract: string, vault: number) => void;
  onDemo: () => void;
  onStart: () => void;
  onToast: (t: Toast) => void;
  onConnect: () => void;
  onDocs: () => void;
}) {
  if (p.vaultId === null) return <Welcome contract={p.contract} myVaults={p.myVaults} onOpen={p.onOpen} onDemo={p.onDemo} onStart={p.onStart} />;
  return (
    <VaultView
      key={`${p.network}/${p.contract}/${p.vaultId}`}
      network={p.network}
      contract={p.contract}
      vaultId={p.vaultId}
      account={p.account}
      onToast={p.onToast}
      onConnect={p.onConnect}
      onDocs={p.onDocs}
      switcher={<Switcher contract={p.contract} vaultId={p.vaultId} myVaults={p.myVaults} onOpen={p.onOpen} />}
    />
  );
}

const REFRESH_MS = 5000;

type Reason = PendingSpend["reason"];

/** Short labels for the queue; the full sentence from the SDK goes in the tooltip. */
const REASON_LABEL: Partial<Record<Reason, string>> = {
  new_recipient: "New recipient",
  over_approval_threshold: "Above auto-approve",
  oracle_review: "Oracle asked for review",
  needs_attestation: "No risk verdict",
  cross_chain_needs_attestation: "Cross-chain, unverified",
};

const ago = (ns: string) => agoMs(Number(BigInt(ns) / 1_000_000n));

function agoMs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
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
/** `near:bob.near` reads as `bob.near`; other chains keep their name. */
function readableRecipient(recipient: string): string {
  const i = recipient.indexOf(":");
  const [chain, address] = [recipient.slice(0, i), recipient.slice(i + 1)];
  return chain === "near" ? address : `${chain} · ${address}`;
}

/** A system notification; does nothing where the browser refuses. */
function notify(title: string, body: string, tag: string) {
  try {
    const n = new Notification(title, { body, tag, icon: "/logo.svg" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* unsupported or blocked */
  }
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
    <form
      className="picker"
      onSubmit={submit}
      toolname="open_agentguard_vault"
      tooldescription="Open an AgentGuard vault's dashboard by contract and vault id, to see its balance, limits and payments waiting for approval."
    >
      <label className="field">
        <span>Contract</span>
        <input
          className="input mono"
          name="contract"
          toolparamdescription="AgentGuard contract account, e.g. guard.cm-agentguard.testnet"
          value={contract} onChange={(e) => setContract(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <label className="field">
        <span>Vault</span>
        <input
          className="input num"
          name="vault_id"
          toolparamdescription="Vault id, a whole number; 6 is the public demo vault"
          value={vault} onChange={(e) => setVault(e.target.value)} inputMode="numeric" placeholder="0" />
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
  // The button sits at the right of the header on wide screens and at the left once the
  // header wraps, so open the popover toward whichever side has room.
  const [side, setSide] = useState<"left" | "right">("right");
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const d = e.currentTarget;
    if (!d.open) return;
    const r = d.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 32);
    setSide(r.right - width >= 16 ? "right" : "left");
  };
  return (
    <details className="switcher" onToggle={onToggle}>
      <summary className="btn secondary">
        Switch vault <Icon name="chevronDown" size={14} />
      </summary>
      <div className={`panel switcher-pop ${side}`}>
        <div className="panel-body">
          <Picker contract={p.contract} vaultId={p.vaultId} myVaults={p.myVaults} onOpen={p.onOpen} />
        </div>
      </div>
    </details>
  );
}

function Welcome(p: { contract: string; myVaults: number[]; onOpen: (contract: string, vault: number) => void; onDemo: () => void; onStart: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="welcome">
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

function VaultView(p: { network: Network; contract: string; vaultId: number; account: string | null; onToast: (t: Toast) => void; onConnect: () => void; onDocs: () => void; switcher: ReactNode }) {
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

  // Held-payment alerts: a system notification while this tab is open, even in the background.
  const alertKey = `agentguard.alerts.${p.network}/${p.contract}/${p.vaultId}`;
  const [alerts, setAlerts] = useState(() => {
    try {
      return localStorage.getItem(alertKey) === "1" && "Notification" in window && Notification.permission === "granted";
    } catch {
      return false;
    }
  });
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const remember = (on: boolean) => {
    try {
      localStorage.setItem(alertKey, on ? "1" : "0");
    } catch {
      /* alerts stay on for this visit only */
    }
  };
  const toggleAlerts = async () => {
    if (alerts) {
      setAlerts(false);
      remember(false);
      return;
    }
    if (!("Notification" in window)) {
      p.onToast({ kind: "err", text: "This browser cannot show notifications." });
      return;
    }
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") {
      p.onToast({ kind: "err", text: "Notifications are blocked for this site. Allow them in the browser's site settings." });
      return;
    }
    setAlerts(true);
    remember(true);
    p.onToast({ kind: "ok", text: "Alerts on. You get a notification when a payment is held, as long as this tab is open." });
  };

  // Poll while the tab is visible, or in the background while alerts are on; refresh at
  // once when it comes back.
  useEffect(() => {
    load();
    const t = setInterval(() => (document.visibilityState === "visible" || alertsRef.current) && load(), REFRESH_MS);
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load]);

  // Notify about payments held since the last poll, and about the vault pausing. The first
  // load only records what is already there.
  const seen = useRef<Set<number> | null>(null);
  const wasPaused = useRef<boolean | null>(null);
  useEffect(() => {
    if (!vault) return;
    const before = seen.current;
    const pausedBefore = wasPaused.current;
    seen.current = new Set(vault.pending.map((s) => s.id));
    wasPaused.current = vault.paused;
    if (!before || !alertsRef.current) return;
    for (const s of vault.pending) {
      if (before.has(s.id)) continue;
      const d = decimals[s.request.token];
      const amount = d == null ? `${s.request.amount} base units` : `${pretty(s.request.amount, d)} ${symbol(s.request.token)}`;
      notify(`Payment waiting: ${amount}`, `To ${readableRecipient(s.request.recipient)}. ${REASON_TEXT[s.reason]}`, `ag-${p.vaultId}-${s.id}`);
    }
    if (pausedBefore === false && vault.paused) notify(`Vault #${p.vaultId} paused`, "Every spend is refused until you resume.", `ag-${p.vaultId}-paused`);
  }, [vault, decimals, p.vaultId]);

  // "(2) AgentGuard": the waiting count shows in the tab title.
  const waiting = vault?.pending.length ?? 0;
  useEffect(() => {
    const strip = (t: string) => t.replace(/^\(\d+\) /, "");
    document.title = waiting ? `(${waiting}) ${strip(document.title)}` : strip(document.title);
    return () => {
      document.title = strip(document.title);
    };
  }, [waiting]);

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
    <main id="main" tabIndex={-1} className="col">
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
              <Icon name="code" size={14} /> Contract <span className="mono" title={p.contract}>{p.contract}</span>
              <span className="net">{p.network}</span>
            </span>
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
        </div>
      </section>

      {!isOwner && (
        <div className="banner info" role="status">
          <Icon name="info" size={18} />
          <p>
            {p.account ? (
              <>
                <b>Read-only.</b> You are signed in as <span className="mono">{p.account}</span>, which does not own this vault, so actions are turned off.
              </>
            ) : (
              <>
                <b>Read-only view.</b> Anyone can inspect a vault. To approve, pause or withdraw, connect the owner's wallet.
              </>
            )}
          </p>
          {!p.account && (
            <button className="btn sm" onClick={p.onConnect}>
              <Icon name="wallet" size={14} /> Connect
            </button>
          )}
        </div>
      )}

      <HowToRead onDocs={p.onDocs} />

      {vault.paused && (
        <div className="banner danger" role="status">
          <Icon name="shieldOff" size={18} />
          <p>
            <b>Every spend is refused while paused.</b> Review what is waiting below, then resume when you are ready. Withdrawals still work.
          </p>
        </div>
      )}

      <section className="stats" aria-label="Vault at a glance">
        <Stat icon="wallet" label="Balance" hint="Funds held by the contract for this vault. The agent never holds them; it can only ask to spend." value={balance} unit={balanceUnit} sub={otherTokens ? `+ ${otherTokens} other token${otherTokens > 1 ? "s" : ""}` : "Held by the vault, not the agent"} />
        <Stat
          icon="clock"
          label="Spent this period"
          hint="What the agent has spent in the current budget window, against the period limit in the guardrails."
          value={limits ? fmt(primary, spentNow(primary))[0] : "—"}
          unit={limits ? `of ${fmtText(primary, limits.period_limit)}` : ""}
          meter={limits ? spentShare : undefined}
          tone={tone(spentShare)}
          sub={periodOver ? "Window ended; the next request starts a new one" : `Resets in ${until(periodEnds)}`}
        />
        <Stat
          icon="bot"
          label="Requests this hour"
          hint="Spend requests in the current hour, against the hourly rate limit. Runaway loops hit this first."
          value={String(hourReqs)}
          unit={`of ${vault.policy.max_requests_per_hour}`}
          meter={reqShare}
          tone={tone(reqShare)}
          sub={vault.policy.pause_on_rate_limit ? "Hitting the limit pauses the vault" : "Over the limit, requests are refused"}
        />
        <Stat
          icon="inbox"
          label="Waiting for you"
          hint="Payments the policy held instead of paying: new recipients, amounts above auto-approve, or oracle reviews."
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
              <button
                className="btn ghost sm"
                aria-pressed={alerts}
                onClick={toggleAlerts}
                title="A notification when a payment is held, while this tab is open. For alerts with the dashboard closed, run agentguard-watch (see the docs)."
              >
                <Icon name="bell" size={14} /> {alerts ? "Alerts on" : "Alert me"}
              </button>
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

          <ActivityLog
            network={p.network}
            contract={p.contract}
            vaultId={p.vaultId}
            version={[vault.nonce, vault.pending.map((s) => s.id).join(","), vault.paused, JSON.stringify(vault.balances), vault.agent, vault.oracle_pk, JSON.stringify(vault.policy)].join("|")}
            waiting={vault.pending.map((s) => s.id)}
            fmtText={fmtText}
          />

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
          <TerminalPanel network={p.network} contract={p.contract} vaultId={p.vaultId} owner={vault.owner} pendingId={vault.pending.at(-1)?.id} />
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- activity

const EXPLORER_TX: Record<Network, string> = { testnet: "https://testnet.nearblocks.io/txns/", mainnet: "https://nearblocks.io/txns/" };
const ACTIVITY_PAGE = 15;

type Filter = "all" | "paid" | "held" | "refused";
const FILTERS: [Filter, string, ActivityEvent | null][] = [
  ["all", "All", null],
  ["paid", "Paid", "spend_executed"],
  ["held", "Held", "spend_pending"],
  ["refused", "Refused", "spend_denied"],
];

const reasonText = (r: string) => (REASON_TEXT as Record<string, string>)[r] ?? r.replaceAll("_", " ");

type Line = { icon: IconName; tone: "ok" | "warn" | "danger" | ""; title: ReactNode; detail?: ReactNode };

/** What the vault did, rebuilt from the contract's events. */
function ActivityLog(p: { network: Network; contract: string; vaultId: number; version: string; waiting: number[]; fmtText: (token: string, raw: string) => string }) {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(ACTIVITY_PAGE);

  // Refetch when the vault changes, not on every poll. The indexer trails the RPC by a few
  // seconds, so look once more shortly after.
  useEffect(() => {
    let live = true;
    const fetchNow = () =>
      getActivity(p.network, p.contract, p.vaultId)
        .then((a) => live && (setItems(a), setError(null)))
        .catch((e) => live && setError((e as Error).message));
    fetchNow();
    const t = setTimeout(fetchNow, 6000);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [p.network, p.contract, p.vaultId, p.version]);

  const outcome = useMemo(() => {
    const m = new Map<number, "approved" | "rejected">();
    for (const a of items ?? []) {
      if (a.event === "pending_approved") m.set(a.data.pending_id, "approved");
      if (a.event === "pending_rejected") m.set(a.data.pending_id, "rejected");
    }
    return m;
  }, [items]);

  const describe = (a: Activity): Line => {
    const d = a.data;
    const r = d.request ?? d;
    const amount = r.token && r.amount ? p.fmtText(r.token, r.amount) : "";
    const to = r.recipient ? <span className="mono">{readableRecipient(r.recipient)}</span> : null;
    const purpose = r.purpose ? <span className="act-purpose">“{r.purpose}”</span> : null;
    switch (a.event) {
      case "spend_executed":
        return { icon: "check", tone: "ok", title: <>Paid <b>{amount}</b> to {to}</>, detail: purpose };
      case "spend_pending": {
        const state = outcome.get(d.pending_id) ?? (p.waiting.includes(d.pending_id) ? "waiting" : null);
        return {
          icon: "clock",
          tone: "warn",
          title: (
            <>
              Held <b>{amount}</b> for {to}
              {state && <span className={`badge ${state === "approved" ? "ok" : state === "rejected" ? "danger" : "warn"}`}>{state}</span>}
            </>
          ),
          detail: <>#{d.pending_id} · {reasonText(d.reason)} {purpose}</>,
        };
      }
      case "spend_denied":
        return { icon: "x", tone: "danger", title: <>Refused <b>{amount}</b> to {to}</>, detail: <>{reasonText(d.reason)} <code>{d.reason}</code> {purpose}</> };
      case "pending_approved":
        return { icon: "check", tone: "", title: <>Owner approved held payment #{d.pending_id}</> };
      case "pending_rejected":
        return { icon: "x", tone: "", title: <>Owner rejected held payment #{d.pending_id}</> };
      case "vault_paused":
        return d.by === "rate_limit"
          ? { icon: "shieldOff", tone: "danger", title: <>Paused automatically: too many requests in an hour</> }
          : { icon: "shieldOff", tone: "danger", title: <>Owner paused the vault (kill switch)</> };
      case "vault_unpaused":
        return { icon: "play", tone: "", title: <>Owner resumed the vault</> };
      case "withdrawn":
        return { icon: "download", tone: "", title: <>Owner withdrew <b>{amount}</b>{d.to && <> to <span className="mono">{d.to}</span></>}</> };
      case "deposited":
        return { icon: "wallet", tone: "", title: <>Deposit of <b>{amount}</b>{d.from && <> from <span className="mono">{d.from}</span></>}</> };
      case "policy_updated":
        return { icon: "shieldCheck", tone: "", title: <>Owner changed the policy</> };
      case "agent_set":
        return { icon: "bot", tone: "", title: d.agent ? <>Agent set to <span className="mono">{d.agent}</span></> : <>Owner revoked the agent</> };
      case "oracle_set":
        return { icon: "scan", tone: "", title: <>Owner changed the oracle key</> };
      case "vault_created":
        return { icon: "sparkle", tone: "", title: <>Vault created by <span className="mono">{d.owner}</span></> };
      case "transfer_failed_refunded":
        return { icon: "alert", tone: "danger", title: <>Transfer of <b>{amount}</b> failed; refunded to the vault</> };
    }
  };

  const want = FILTERS.find(([f]) => f === filter)?.[2];
  const list = (items ?? []).filter((a) => !want || a.event === want);

  return (
    <section className="panel" aria-labelledby="act-h">
      <div className="panel-head">
        <h2 id="act-h"><Icon name="layers" /> Activity</h2>
        <div className="pg-examples" role="group" aria-label="Filter activity">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => (setFilter(f), setShown(ACTIVITY_PAGE))}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {items === null && !error ? (
        <div className="act-loading" aria-busy="true" aria-label="Loading activity">
          {[0, 1, 2].map((i) => <div key={i} className="sk" style={{ height: 14, width: `${80 - i * 15}%` }} />)}
        </div>
      ) : error && items === null ? (
        <div className="empty">
          <span className="bubble"><Icon name="alert" size={20} /></span>
          <b>History is not available right now</b>
          <p>The transaction indexer did not answer ({error}). Balances, limits and the queue above come straight from the contract and are up to date.</p>
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          <span className="bubble"><Icon name="inbox" size={20} /></span>
          <b>{filter === "all" ? "No activity yet" : "Nothing here yet"}</b>
          <p>Every payment the agent asks for shows up here: paid, held for you, or refused with the reason.</p>
        </div>
      ) : (
        <>
          <ul className="act-list">
            {list.slice(0, shown).map((a) => {
              const l = describe(a);
              return (
                <li key={a.key} className={`act ${l.tone}`}>
                  <span className="act-icon"><Icon name={l.icon} size={14} /></span>
                  <div className="act-main">
                    <div className="act-title">{l.title}</div>
                    {l.detail && <div className="act-detail">{l.detail}</div>}
                  </div>
                  <a className="act-time" href={EXPLORER_TX[p.network] + a.tx} target="_blank" rel="noreferrer" title={`${new Date(a.at).toLocaleString()}: open the transaction`}>
                    {agoMs(a.at)}
                  </a>
                </li>
              );
            })}
          </ul>
          <div className="act-foot">
            {list.length > shown ? (
              <button className="btn ghost sm" onClick={() => setShown((n) => n + ACTIVITY_PAGE)}>Show more</button>
            ) : (
              <span className="hint">Recent history from the contract's events</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The same owner actions as near-cli-rs commands, filled in for this vault. */
function TerminalPanel(p: { network: Network; contract: string; vaultId: number; owner: string; pendingId?: number }) {
  return (
    <details className="panel terminal">
      <summary>
        <span className="t-icon"><Icon name="code" size={16} /></span>
        <span>
          <b>Do it from the terminal</b>
          <small>Every action here is a contract call. Copy it for near-cli-rs.</small>
        </span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="terminal-body">
        {ownerOps(p.contract, p.network, p.vaultId, p.owner, p.pendingId ?? "<pending id>").map((op) => (
          <div key={op.title} className="cli-op">
            <b>{op.title}</b>
            {op.note && <span className="hint">{op.note}</span>}
            <CodeBlock code={op.code} />
          </div>
        ))}
        <a className="link-more" href="#/docs/cli">Install and setup in the docs <Icon name="arrowRight" size={14} /></a>
      </div>
    </details>
  );
}

const HELP_KEY = "agentguard.help.dismissed";

/** A first-visit explainer for the vault page; dismissed once, remembered in this browser. */
function HowToRead(p: { onDocs: () => void }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HELP_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(HELP_KEY, "1");
    } catch {
      /* not remembered; it shows again next visit */
    }
  };
  return (
    <section className="howto" aria-label="How to read this page">
      <div className="howto-head">
        <b>How this page works</b>
        <span className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={p.onDocs}>Read the docs</button>
          <button className="btn ghost icon-only sm" onClick={close} aria-label="Hide this guide" title="Hide">
            <Icon name="x" size={15} />
          </button>
        </span>
      </div>
      <ol>
        <li>
          <span className="n ok">1</span>
          <span><b>The agent asks to pay.</b> Each request is checked against the <em>Guardrails</em> on the right.</span>
        </li>
        <li>
          <span className="n warn">2</span>
          <span><b>Unusual payments wait for you</b> in the <em>Approval queue</em>: approve or reject each one.</span>
        </li>
        <li>
          <span className="n danger">3</span>
          <span><b>Something wrong?</b> The <em>Kill switch</em> refuses every spend until you resume. Withdraw works even while paused.</span>
        </li>
      </ol>
    </section>
  );
}

function Stat(p: { icon: IconName; label: string; hint?: string; value: string; unit?: string; sub?: string; meter?: number; tone?: string; attention?: boolean }) {
  return (
    <div className={`panel stat${p.attention ? " attention" : ""}`}>
      <span className="label">
        <Icon name={p.icon} size={14} /> {p.label}
        {p.hint && (
          <span className="hint-dot" tabIndex={0} role="note" aria-label={p.hint} data-tip={p.hint}>
            <Icon name="info" size={13} />
          </span>
        )}
      </span>
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
