// The setup guide: wallet, vault, agent key, MCP, optional oracle. Each step that writes to
// the chain is one wallet transaction; the guide remembers where you are in this browser.
import { useEffect, useState, type ReactNode } from "react";
import { parseUnits } from "@agentguard/sdk/dist/units.js";
import { actions, getVaultsOf, type Network, type Policy } from "./near";
import { Icon } from "./icons";
import { CodeBlock } from "./ui";

type Toast = { kind: "ok" | "err"; text: string };
type Progress = { step: number; vaultId: number | null; agentId: string };

const STORE = "agentguard.onboarding";
const STEPS = ["Connect wallet", "Create a vault", "Give your agent a key", "Connect the agent", "Add the risk oracle", "Done"];

function load(): Progress {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (p && typeof p.step === "number") return { step: p.step, vaultId: p.vaultId ?? null, agentId: p.agentId ?? "" };
  } catch {
    /* private mode or bad data: start over */
  }
  return { step: 0, vaultId: null, agentId: "" };
}

type Limits = { perTx: string; budget: string; auto: string; perHour: string };
const PRESETS: Record<"cautious" | "balanced" | "custom", { label: string; blurb: string; limits: Limits }> = {
  cautious: { label: "Cautious", blurb: "Small daily budget, almost everything asks you first.", limits: { perTx: "0.5", budget: "1", auto: "0.1", perHour: "10" } },
  balanced: { label: "Balanced", blurb: "Routine payments go through, large ones wait for you.", limits: { perTx: "1", budget: "3", auto: "0.5", perHour: "20" } },
  custom: { label: "Custom", blurb: "Set every limit yourself.", limits: { perTx: "2", budget: "5", auto: "1", perHour: "30" } },
};

function buildPolicy(l: Limits, newNeedsApproval: boolean): Policy {
  const y = (x: string) => parseUnits(x.trim(), 24);
  const perHour = Number(l.perHour);
  if (!Number.isInteger(perHour) || perHour < 1) throw new Error("Requests per hour must be a whole number of at least 1.");
  const [perTx, budget, auto] = [y(l.perTx), y(l.budget), y(l.auto)];
  if (BigInt(perTx) > BigInt(budget)) throw new Error("The per-payment cap cannot be larger than the daily budget.");
  if (BigInt(auto) > BigInt(perTx)) throw new Error("Auto-approve should not be above the per-payment cap.");
  return {
    tokens: { near: { max_per_tx: perTx, period_limit: budget, approval_threshold: auto, attestation_threshold: null } },
    period_secs: 86400,
    max_requests_per_hour: perHour,
    allowed_recipients: null,
    denied_recipients: [],
    new_recipient_needs_approval: newNeedsApproval,
    pause_on_rate_limit: true,
  } as Policy;
}

export function Onboarding(p: {
  network: Network;
  contract: string;
  account: string | null;
  onConnect: () => void;
  onOpenVault: (vaultId: number) => void;
  onToast: (t: Toast) => void;
  onDocs: () => void;
}) {
  const [prog, setProg] = useState<Progress>(load);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(prog));
    } catch {
      /* not persisted; the guide still works */
    }
  }, [prog]);

  // Signing out sends you back to the first step; a wallet already connected skips it.
  const step = !p.account ? 0 : Math.max(prog.step, 1);
  const go = (s: number) => setProg((x) => ({ ...x, step: s }));
  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      p.onToast({ kind: "err", text: `${label}: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const done = (i: number) => (i === 0 ? !!p.account : i === 1 ? prog.vaultId !== null : i < step);
  const canVisit = (i: number) => i === 0 || (!!p.account && (i <= 1 || prog.vaultId !== null));

  return (
    <main id="main" tabIndex={-1} className="guide">
      <aside className="guide-rail" aria-label="Setup steps">
        <span className="eyebrow">Setup guide</span>
        <h1>Guard your first agent</h1>
        <p className="muted">About five minutes on NEAR {p.network}. Each on-chain step is one transaction you sign.</p>
        <div className="progress" aria-hidden>
          <i style={{ transform: `scaleX(${step / (STEPS.length - 1)})` }} />
        </div>
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={`${i === step ? "current" : ""}${done(i) ? " done" : ""}`}
                aria-current={i === step ? "step" : undefined}
                disabled={!canVisit(i)}
                onClick={() => go(i)}
              >
                <span className="dot num">{done(i) && i !== step ? <Icon name="check" size={13} /> : i + 1}</span>
                {s}
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className="guide-body panel" aria-live="polite">
        {step === 0 && (
          <Step n={1} title="Connect your NEAR wallet" lede="Your wallet signs as the vault's owner. Only the owner can approve, pause, change the policy or withdraw.">
            <ul className="checks">
              <li><Icon name="check" size={15} /> Any NEAR wallet works: HOT, Meteor, MyNearWallet, Intear and more.</li>
              <li><Icon name="check" size={15} /> On testnet, get free NEAR from the faucet in your wallet or at near-faucet.io.</li>
              <li><Icon name="check" size={15} /> AgentGuard never asks for your seed phrase or private key.</li>
            </ul>
            <div className="step-actions">
              <button className="btn lg" onClick={p.onConnect}>
                <Icon name="wallet" /> Connect wallet
              </button>
            </div>
          </Step>
        )}

        {step === 1 && (
          <CreateVault
            {...p}
            account={p.account!}
            busy={busy}
            vaultId={prog.vaultId}
            onCreate={(policy, deposit) =>
              run("Create vault", async () => {
                const id = await actions.createVault(p.network, p.contract, p.account!, policy, null, deposit);
                setProg((x) => ({ ...x, vaultId: id, step: 2 }));
                p.onToast({ kind: "ok", text: `Vault #${id} created.` });
              })
            }
            onPick={(id) => setProg((x) => ({ ...x, vaultId: id, step: 2 }))}
          />
        )}

        {step === 2 && prog.vaultId !== null && (
          <AgentKey
            network={p.network}
            contract={p.contract}
            account={p.account!}
            vaultId={prog.vaultId}
            agentId={prog.agentId}
            busy={busy}
            onSet={(agentId) =>
              run("Set agent", async () => {
                await actions.setAgent(p.network, p.contract, prog.vaultId!, agentId);
                setProg((x) => ({ ...x, agentId, step: 3 }));
                p.onToast({ kind: "ok", text: `${agentId} can now ask to spend from vault #${prog.vaultId}.` });
              })
            }
            onSkip={() => go(3)}
          />
        )}

        {step === 3 && prog.vaultId !== null && (
          <Step n={4} title="Connect the agent over MCP" lede="The AgentGuard MCP server gives any MCP client four tools: check the budget, pay, and follow held or cross-chain payments.">
            <h3 className="sub-h">1. Build the MCP server</h3>
            <CodeBlock code={`git clone https://github.com/CodeMasterLabs/agentguard\ncd agentguard && npm install && npm run build`} />
            <h3 className="sub-h">2. Add it to your agent's MCP config</h3>
            <p className="hint">In Claude Desktop this is claude_desktop_config.json; in Claude Code, .mcp.json. Paste the key from .env.agent.</p>
            <CodeBlock label="MCP config (JSON)" code={mcpConfig(p.contract, prog.vaultId, prog.agentId || `agent1.${p.account}`)} />
            <h3 className="sub-h">3. Try it</h3>
            <div className="try">
              <Icon name="bot" size={16} />
              <p>"Check my AgentGuard budget, then pay 0.1 NEAR to <span className="mono">near:{p.account}</span> for a test."</p>
            </div>
            <p className="hint">The first payment to a new recipient waits for your approval. Approve it on the dashboard and the next one goes straight through.</p>
            <div className="step-actions">
              <button className="btn lg" onClick={() => go(4)}>
                Next <Icon name="arrowRight" />
              </button>
            </div>
          </Step>
        )}

        {step === 4 && prog.vaultId !== null && (
          <OracleStep
            busy={busy}
            onSet={(pk) =>
              run("Set oracle", async () => {
                await actions.setOracle(p.network, p.contract, prog.vaultId!, pk);
                go(5);
                p.onToast({ kind: "ok", text: "Risk oracle registered." });
              })
            }
            onSkip={() => go(5)}
            onDocs={p.onDocs}
          />
        )}

        {step === 5 && prog.vaultId !== null && (
          <Step n={6} title="Your agent is guarded" lede={`Vault #${prog.vaultId} is live. Everything the agent asks for now goes through your policy.`}>
            <div className="done-art" aria-hidden>
              <svg viewBox="0 0 120 120" width="112" height="112">
                <circle cx="60" cy="60" r="54" className="done-ring" />
                <path d="M60 22l28 10v22c0 19-12 34-28 40-16-6-28-21-28-40V32z" className="done-shield" />
                <path d="M47 60l9 9 17-19" className="done-check" />
              </svg>
            </div>
            <ul className="checks">
              <li><Icon name="inbox" size={15} /> Held payments appear in your approval queue.</li>
              <li><Icon name="power" size={15} /> The kill switch pauses the agent instantly, from any key.</li>
              <li><Icon name="download" size={15} /> You can withdraw at any time, even while paused.</li>
            </ul>
            <div className="step-actions">
              <button className="btn lg" onClick={() => p.onOpenVault(prog.vaultId!)}>
                Open vault #{prog.vaultId} <Icon name="arrowRight" />
              </button>
              <button className="btn lg ghost" onClick={() => setProg({ step: 1, vaultId: null, agentId: "" })}>
                Set up another
              </button>
            </div>
          </Step>
        )}
      </section>
    </main>
  );
}

function Step(p: { n: number; title: string; lede: string; children: ReactNode }) {
  return (
    <div className="step" key={p.n}>
      <span className="eyebrow">Step {p.n} of {STEPS.length}</span>
      <h2>{p.title}</h2>
      <p className="step-lede">{p.lede}</p>
      {p.children}
    </div>
  );
}

function CreateVault(p: {
  network: Network;
  contract: string;
  account: string;
  busy: boolean;
  vaultId: number | null;
  onCreate: (policy: Policy, depositYocto: string) => void;
  onPick: (id: number) => void;
}) {
  const [preset, setPreset] = useState<keyof typeof PRESETS>("balanced");
  const [limits, setLimits] = useState<Limits>(PRESETS.balanced.limits);
  const [newNeedsApproval, setNewNeedsApproval] = useState(true);
  const [deposit, setDeposit] = useState("2");
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<number[]>([]);
  useEffect(() => {
    getVaultsOf(p.network, p.contract, p.account).then(setMine).catch(() => setMine([]));
  }, [p.network, p.contract, p.account]);

  const pick = (k: keyof typeof PRESETS) => (setPreset(k), setLimits(PRESETS[k].limits));
  const field = (k: keyof Limits, label: string, unit: string, help: string) => (
    <label className="field">
      <span>{label}</span>
      <span className="unit-field">
        <input
          className="input num"
          value={limits[k]}
          inputMode={k === "perHour" ? "numeric" : "decimal"}
          onChange={(e) => (setPreset("custom"), setLimits((l) => ({ ...l, [k]: e.target.value })))}
        />
        <i>{unit}</i>
      </span>
      <small className="hint">{help}</small>
    </label>
  );
  const submit = () => {
    try {
      setErr(null);
      const d = parseUnits(deposit.trim(), 24);
      if (BigInt(d) < 10n ** 23n) throw new Error("Attach at least 0.1 NEAR: part pays the vault's storage, the rest is its balance.");
      p.onCreate(buildPolicy(limits, newNeedsApproval), d);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Step n={2} title="Create a vault and choose its rules" lede="The vault holds the agent's spending money. The policy is enforced by the contract on every request; you can change it later.">
      <div className="presets" role="radiogroup" aria-label="Policy preset">
        {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={preset === k} className="preset" onClick={() => pick(k)}>
            <b>{PRESETS[k].label}</b>
            <span>{PRESETS[k].blurb}</span>
          </button>
        ))}
      </div>
      <div className="form-grid">
        {field("perTx", "Max per payment", "NEAR", "Anything larger is refused.")}
        {field("budget", "Daily budget", "NEAR", "Total the agent can spend per 24 h.")}
        {field("auto", "Auto-approve up to", "NEAR", "Larger payments wait for you.")}
        {field("perHour", "Requests per hour", "req", "Going over pauses the vault.")}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={newNeedsApproval} onChange={(e) => setNewNeedsApproval(e.target.checked)} />
        <span className="track" aria-hidden><i /></span>
        <span>
          <b>Ask me before paying a new recipient</b>
          <small className="hint">Recommended. Stops look-alike and injected addresses on first contact.</small>
        </span>
      </label>
      <label className="field deposit">
        <span>Starting balance</span>
        <span className="unit-field">
          <input className="input num" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
          <i>NEAR</i>
        </span>
        <small className="hint">A few milliNEAR pay for the vault's storage; the rest is what the agent can spend. Top up any time.</small>
      </label>
      {err && <p className="form-err"><Icon name="alert" size={14} /> {err}</p>}
      <div className="step-actions">
        <button className="btn lg" disabled={p.busy} onClick={submit}>
          {p.busy ? "Waiting for your wallet…" : "Create vault"} {!p.busy && <Icon name="arrowRight" />}
        </button>
        <span className="hint">Signs one transaction on <span className="mono">{p.contract}</span></span>
      </div>
      {mine.length > 0 && (
        <div className="have">
          <span>Already have a vault?</span>
          {mine.map((v) => (
            <button key={v} className="chip" aria-pressed={v === p.vaultId} onClick={() => p.onPick(v)}>#{v}</button>
          ))}
        </div>
      )}
    </Step>
  );
}

function AgentKey(p: { network: Network; contract: string; account: string; vaultId: number; agentId: string; busy: boolean; onSet: (id: string) => void; onSkip: () => void }) {
  const [agent, setAgent] = useState(p.agentId || `agent1.${p.account}`);
  const valid = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(agent) && agent.length >= 2 && agent.length <= 64;
  const prefix = agent.endsWith(`.${p.account}`) ? agent.slice(0, -(p.account.length + 1)) : "agent1";
  return (
    <Step n={3} title="Give your agent a key that can only ask" lede="The agent gets its own account whose only key can call request_spend on this contract. It cannot transfer, add keys or call anything else.">
      <div className="key-diagram" aria-hidden>
        <div className="kd-node"><Icon name="bot" size={18} /> agent key</div>
        <div className="kd-line ok"><span>request_spend</span></div>
        <div className="kd-node guard"><Icon name="shieldCheck" size={18} /> AgentGuard</div>
        <div className="kd-blocked">
          <span><Icon name="x" size={12} /> transfer</span>
          <span><Icon name="x" size={12} /> add key</span>
          <span><Icon name="x" size={12} /> other contracts</span>
        </div>
      </div>
      <h3 className="sub-h">1. Create the agent account</h3>
      <p className="hint">Run this from the repository root. It creates <span className="mono">{agent}</span>, funds it with 0.5 NEAR for gas, and writes its key to .env.agent (never commit it).</p>
      <CodeBlock
        code={`OWNER_ID=${p.account} \\\nAGENTGUARD_CONTRACT=${p.contract} \\\nOWNER_PRIVATE_KEY=ed25519:<your key> \\\nnode --experimental-strip-types scripts/provision-agent.ts ${prefix}`}
      />
      <h3 className="sub-h">2. Link it to vault #{p.vaultId}</h3>
      <div className="inline-form">
        <label className="field">
          <span>Agent account</span>
          <input className="input mono" value={agent} onChange={(e) => setAgent(e.target.value.trim())} spellCheck={false} autoComplete="off" />
        </label>
        <button className="btn lg" disabled={p.busy || !valid} onClick={() => p.onSet(agent)}>
          {p.busy ? "Waiting for your wallet…" : "Set as agent"}
        </button>
      </div>
      <div className="step-actions">
        <button className="btn ghost" onClick={p.onSkip}>I'll do this later</button>
      </div>
    </Step>
  );
}

function OracleStep(p: { busy: boolean; onSet: (pk: string) => void; onSkip: () => void; onDocs: () => void }) {
  const [pk, setPk] = useState("");
  const valid = /^[0-9a-f]{64}$/i.test(pk.trim());
  return (
    <Step n={5} title="Add the risk oracle (optional)" lede="Limits see amounts and addresses. The oracle reads the text behind each payment and catches injected instructions, look-alike addresses and vague purposes.">
      <ul className="checks">
        <li><Icon name="scan" size={15} /> Runs inside Intel TDX on OutLayer, with a signing key no one holds.</li>
        <li><Icon name="shieldCheck" size={15} /> The contract verifies every verdict signature; an agent cannot fake one.</li>
        <li><Icon name="info" size={15} /> Start the gateway, then paste the key from <span className="mono">GET /pubkey</span>.</li>
      </ul>
      <CodeBlock code={`npm run gateway -w oracle   # TEE-backed POST /verdict and GET /pubkey\ncurl -s localhost:8788/pubkey`} />
      <div className="inline-form">
        <label className="field">
          <span>Oracle public key (64 hex characters)</span>
          <input className="input mono" value={pk} onChange={(e) => setPk(e.target.value)} spellCheck={false} autoComplete="off" placeholder="e.g. 3f1c…" />
        </label>
        <button className="btn lg" disabled={p.busy || !valid} onClick={() => p.onSet(pk.trim().toLowerCase())}>
          {p.busy ? "Waiting for your wallet…" : "Register oracle"}
        </button>
      </div>
      <div className="step-actions">
        <button className="btn ghost" onClick={p.onSkip}>Skip for now</button>
        <button className="btn ghost" onClick={p.onDocs}>How the oracle works</button>
      </div>
    </Step>
  );
}

export function mcpConfig(contract: string, vaultId: number | string, agent: string) {
  return JSON.stringify(
    {
      mcpServers: {
        agentguard: {
          command: "node",
          args: ["<path to>/agentguard/mcp/dist/index.js"],
          env: {
            AGENTGUARD_CONTRACT: contract,
            AGENTGUARD_VAULT_ID: String(vaultId),
            AGENT_ACCOUNT_ID: agent,
            AGENT_PRIVATE_KEY: "ed25519:<from .env.agent>",
            AGENTGUARD_ORACLE_URL: "",
          },
        },
      },
    },
    null,
    2,
  );
}
