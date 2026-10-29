// In-app documentation: one page, a table of contents that follows your scroll.
import { useEffect, useState, type ReactNode } from "react";
import { REASON_TEXT } from "@agentguard/sdk/dist/types.js";
import { REPO } from "./chrome";
import { Icon } from "./icons";
import { FAQ } from "./landing";
import { mcpConfig } from "./onboarding";
import { CLI_INSTALL, createVaultCmd, ownerOps } from "./cli";
import { CodeBlock } from "./ui";

const TOC = [
  ["overview", "Overview"],
  ["concepts", "Core concepts"],
  ["decisions", "How a payment is decided"],
  ["quickstart", "Quickstart"],
  ["policy", "Policy reference"],
  ["mcp", "MCP tools"],
  ["cli", "Owner CLI"],
  ["alerts", "Activity and alerts"],
  ["oracle", "Risk oracle and TEE"],
  ["crosschain", "Cross-chain payments"],
  ["security", "Security model"],
  ["faq", "FAQ"],
  ["glossary", "Glossary"],
] as const;

const DENY: (keyof typeof REASON_TEXT)[] = [
  "paused", "token_not_allowed", "zero_amount", "recipient_denied", "recipient_not_allowed", "rate_limited",
  "over_per_tx_cap", "over_period_limit", "oracle_denied", "bad_attestation", "insufficient_balance", "pending_queue_full",
];
const HOLD: (keyof typeof REASON_TEXT)[] = ["oracle_review", "over_approval_threshold", "needs_attestation", "cross_chain_needs_attestation", "new_recipient"];

const POLICY_FIELDS: [string, string, string][] = [
  ["tokens.<id>.max_per_tx", "string (base units)", "Largest single payment. Anything above is refused."],
  ["tokens.<id>.period_limit", "string (base units)", "Total spend per period. Must be at least max_per_tx."],
  ["tokens.<id>.approval_threshold", "string (base units)", "Payments above this wait for the owner."],
  ["tokens.<id>.attestation_threshold", "string | null", "From this amount a signed oracle verdict is required; null never requires one."],
  ["period_secs", "number", "Length of the budget window in seconds (86400 = one day)."],
  ["max_requests_per_hour", "number", "Spend requests allowed per rolling hour."],
  ["pause_on_rate_limit", "boolean", "Pause the whole vault when the hourly limit is hit, instead of only refusing."],
  ["allowed_recipients", "string[] | null", "If set, only these recipients can be paid. null allows anyone not denied."],
  ["denied_recipients", "string[]", "Never pay these recipients (also checked against pay_to)."],
  ["new_recipient_needs_approval", "boolean", "Hold the first payment to any recipient the vault has not paid before."],
];

const TOOLS: [string, string, string][] = [
  ["agentguard_budget", "none", "Balances, per-token limits, what is left this period, paused state and held payments. Agents should call it before paying."],
  ["agentguard_pay", "token, amount, recipient, purpose, context?, receive_token?", "Ask to pay. Returns executed, pending (with a reason and id) or denied (with a reason)."],
  ["agentguard_pending", "pending_id", "Is a held payment still waiting? A missing id means the owner approved or rejected it."],
  ["agentguard_swap_status", "deposit_address", "Delivery status of a cross-chain payment through NEAR Intents."],
];

const GLOSSARY: [string, string][] = [
  ["Vault", "A balance inside the AgentGuard contract, owned by one account, with one policy and at most one agent."],
  ["Owner", "The account that created the vault. Only it can approve, change the policy, set the agent or oracle, and withdraw."],
  ["Agent", "The account allowed to call request_spend on a vault. Its key is a function-call key limited to that one method."],
  ["Policy", "The rules the contract checks on every request: caps, budgets, rate limit and recipient lists."],
  ["Attestation", "An ed25519-signed verdict from the risk oracle, bound to the exact request, vault and nonce, valid for a short time."],
  ["Held payment", "A request the policy did not refuse but will not execute alone. It waits in the approval queue."],
  ["Kill switch", "pause: refuses every spend until the owner resumes. Needs no deposit, so a limited key can trigger it."],
  ["TEE", "Trusted execution environment. Here Intel TDX on OutLayer, which proves which code produced a verdict."],
];

export function Docs(p: { contract: string; onStart: () => void }) {
  const [active, setActive] = useState<string>("overview");
  // The current section is the last one whose heading has scrolled past the header. (Picking
  // the topmost section in view chose the previous one whenever its tail was still showing.)
  useEffect(() => {
    const els = TOC.map(([id]) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = 120;
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
      const current = atEnd ? els.at(-1) : (els.filter((el) => el.getBoundingClientRect().top <= line).at(-1) ?? els[0]);
      if (current) setActive(current.id);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);
  // Deep links (#/docs/policy) land on their section, on arrival and when the hash changes.
  useEffect(() => {
    const land = () => {
      const sub = location.hash.split("/")[2];
      if (sub) setTimeout(() => document.getElementById(sub)?.scrollIntoView(), 60);
    };
    land();
    addEventListener("hashchange", land);
    return () => removeEventListener("hashchange", land);
  }, []);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  return (
    <div className="docs">
      <nav className="docs-nav" aria-label="Documentation">
        <span className="eyebrow">Documentation</span>
        <ul>
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a
                href={`#/docs/${id}`}
                aria-current={active === id ? "location" : undefined}
                onClick={(e) => (e.preventDefault(), jump(id))}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
        <a className="docs-ext" href={REPO} target="_blank" rel="noreferrer">
          Source on GitHub <Icon name="arrowUpRight" size={13} />
        </a>
      </nav>

      <main id="main" tabIndex={-1} className="docs-body prose">
        <Sec id="overview" title="Overview">
          <p className="lead">
            AgentGuard lets an AI agent pay for things on NEAR without holding the money. The funds sit in a vault you own; the agent
            can only <em>ask</em> to spend, and a smart contract decides each request against your policy and, optionally, a signed
            verdict from a risk oracle running in a TEE.
          </p>
          <div className="doc-cards">
            <Card icon="wallet" title="Contract">Vaults, policy engine, approvals, kill switch. Rust, on NEAR.</Card>
            <Card icon="bot" title="MCP server">Four tools any MCP client can use to check budget and pay.</Card>
            <Card icon="scan" title="Risk oracle">Scores the text behind a payment; signs allow, review or deny.</Card>
            <Card icon="code" title="SDK">TypeScript client for owners and agents.</Card>
          </div>
        </Sec>

        <Sec id="concepts" title="Core concepts">
          <p>
            <b>Owner, agent, vault.</b> You (the owner) create a vault and fund it. You link one agent account to it. That account's only
            key is a function-call key for <code>request_spend</code> on the AgentGuard contract, with a small gas allowance. Even if the
            agent is fully compromised, the most it can do is ask.
          </p>
          <p>
            <b>Three outcomes.</b> Every request ends in exactly one of: <Pill tone="ok">executed</Pill> the funds move in the same
            transaction; <Pill tone="warn">pending</Pill> the request joins your approval queue; <Pill tone="danger">denied</Pill>{" "}
            nothing happens and the agent gets a reason code.
          </p>
          <p>
            <b>Windows.</b> Budgets reset every <code>period_secs</code>, request counts every hour. Both roll forward on the next request,
            so the dashboard shows what that request will see.
          </p>
        </Sec>

        <Sec id="decisions" title="How a payment is decided">
          <p>Checks run in this order. The first hard denial wins; if none applies, the first hold reason wins; otherwise the payment executes.</p>
          <div className="reason-grid">
            <div>
              <h3><Pill tone="danger">Denied</Pill></h3>
              <ul className="reasons">
                {DENY.map((r) => (
                  <li key={r}><code>{r}</code><span>{REASON_TEXT[r]}</span></li>
                ))}
              </ul>
            </div>
            <div>
              <h3><Pill tone="warn">Held for you</Pill></h3>
              <ul className="reasons">
                {HOLD.map((r) => (
                  <li key={r}><code>{r}</code><span>{REASON_TEXT[r]}</span></li>
                ))}
              </ul>
              <h3 style={{ marginTop: 20 }}><Pill tone="ok">Executed</Pill></h3>
              <p className="hint">Debit the vault, record usage, send the funds. If the transfer fails, the vault is re-credited.</p>
            </div>
          </div>
        </Sec>

        <Sec id="quickstart" title="Quickstart">
          <p>The fastest path is the setup guide, which signs each step in your wallet and fills in these commands for you.</p>
          <button className="btn" onClick={p.onStart}>Open the setup guide <Icon name="arrowRight" /></button>
          <ol className="doc-steps">
            <li><b>Clone and build.</b><CodeBlock code={`git clone ${REPO}\ncd agentguard && npm install && npm run build`} /></li>
            <li><b>Create a vault</b> with <code>create_vault</code>, attaching at least 0.1 NEAR plus the starting balance. Use the dashboard guide or <code>scripts/demo-policy.json</code>.</li>
            <li>
              <b>Provision the agent</b> (writes <code>.env.agent</code>), then call <code>set_agent</code> on the vault:
              <CodeBlock code={`OWNER_ID=you.testnet AGENTGUARD_CONTRACT=${p.contract} \\\nOWNER_PRIVATE_KEY=ed25519:... \\\nnode --experimental-strip-types scripts/provision-agent.ts agent1`} />
            </li>
            <li><b>Add the MCP server</b> to your client:<CodeBlock label="MCP config (JSON)" code={mcpConfig(p.contract, 0, "agent1.you.testnet")} /></li>
            <li><b>Ask the agent to pay.</b> With the default policy the first payment to a new recipient is held; approve it on the dashboard and the next one executes at once.</li>
          </ol>
        </Sec>

        <Sec id="policy" title="Policy reference">
          <p>Amounts are strings in the token's base units (yoctoNEAR for NEAR: 1 NEAR = 10²⁴). A policy can hold several tokens: <code>"near"</code> or any NEP-141 contract id.</p>
          <div className="table-wrap">
            <table className="doc-table">
              <thead><tr><th>Field</th><th>Type</th><th>Meaning</th></tr></thead>
              <tbody>
                {POLICY_FIELDS.map(([f, t, m]) => (
                  <tr key={f}><td><code>{f}</code></td><td className="nowrap">{t}</td><td>{m}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock label="scripts/demo-policy.json" code={DEMO_POLICY} />
        </Sec>

        <Sec id="mcp" title="MCP tools">
          <p>The MCP server signs with the agent's limited key. Environment: <code>AGENTGUARD_CONTRACT</code>, <code>AGENTGUARD_VAULT_ID</code>, <code>AGENT_ACCOUNT_ID</code>, <code>AGENT_PRIVATE_KEY</code>, and optionally <code>AGENTGUARD_ORACLE_URL</code>, <code>AGENTGUARD_ORACLE_TOKEN</code>, <code>ONECLICK_JWT</code>.</p>
          <div className="table-wrap">
            <table className="doc-table">
              <thead><tr><th>Tool</th><th>Inputs</th><th>What it does</th></tr></thead>
              <tbody>
                {TOOLS.map(([n, i, d]) => (
                  <tr key={n}><td><code>{n}</code></td><td><code className="soft">{i}</code></td><td>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">The pay tool tells the agent never to retry a denied payment with a different recipient or a split amount. The contract enforces limits either way.</p>
        </Sec>

        <Sec id="cli" title="Owner CLI">
          <p>
            The dashboard is optional. Every button in it is an ordinary call to the AgentGuard contract, so you can run a vault entirely
            from a terminal, a script or a DAO proposal. These commands use{" "}
            <a href="https://github.com/near/near-cli-rs" target="_blank" rel="noreferrer">near-cli-rs</a>; replace <code>you.testnet</code>{" "}
            with the owner account and <code>0</code> with your vault id. Leave off the end of a command and the CLI asks for what is missing.
          </p>
          <p className="hint">On the dashboard, the vault page has the same commands filled in for that vault, under "Do it from the terminal".</p>
          <ol className="doc-steps">
            <li><b>Install the CLI and sign in</b> as the owner (stores the key in your system keychain):<CodeBlock code={CLI_INSTALL} /></li>
            <li><b>Create a vault</b> with the demo policy and 0.5 NEAR (needs jq; the call returns the vault id):<CodeBlock code={createVaultCmd(p.contract, "testnet", "you.testnet")} /></li>
          </ol>
          <h3 className="cli-h">Run a vault</h3>
          <div className="cli-ops">
            {ownerOps(p.contract, "testnet", 0, "you.testnet").map((op) => (
              <div key={op.title} className="cli-op">
                <b>{op.title}</b>
                {op.note && <span className="hint">{op.note}</span>}
                <CodeBlock code={op.code} />
              </div>
            ))}
          </div>
          <p className="hint">Each owner call attaches 1 yoctoNEAR, which only a full-access key can sign, so a leaked function-call key cannot approve or withdraw. Pause needs none, so it works from any of your keys.</p>
        </Sec>

        <Sec id="alerts" title="Activity and alerts">
          <p>
            The vault page lists what the vault did: every payment paid, held for you or refused with its reason, and every owner action,
            newest first, each linked to its transaction. The contract keeps no history in state; the list is rebuilt from the events it
            logs on every call, read from FastNEAR's transaction API. If the indexer is down, only the list is missing.
          </p>
          <p>
            A held payment waits for you, so you need to hear about it. Turn on <b>Alert me</b> in the approval queue for a browser
            notification on each new held payment and when the vault pauses, while the tab is open. With the dashboard closed, run{" "}
            <code>agentguard-watch</code> from the repository. It reads the contract (no keys) and sends alerts to ntfy, a Slack or
            Discord webhook, or Telegram:
          </p>
          <CodeBlock code={`npm run build -w sdk -w mcp
AGENTGUARD_CONTRACT=${p.contract} AGENTGUARD_VAULT_ID=0 \\
ALERT_NTFY_URL=https://ntfy.sh/<a-long-random-topic> \\
node mcp/dist/watch.js`} />
          <p className="hint">
            Other channels: <code>ALERT_WEBHOOK_URL</code> (Slack, Discord or any JSON endpoint), or <code>TELEGRAM_BOT_TOKEN</code> with{" "}
            <code>TELEGRAM_CHAT_ID</code>. Several vaults: <code>AGENTGUARD_VAULT_ID=0,4</code>. <code>AGENTGUARD_DASHBOARD_URL</code> adds a
            link to the vault page. An ntfy topic is readable by anyone who knows its name, so pick a long random one.
          </p>
        </Sec>

        <Sec id="oracle" title="Risk oracle and TEE">
          <p>
            <code>POST /verdict</code> takes the spend request plus <code>context</code>, the untrusted text that led the agent to pay. It scores
            signals and returns a signed <Pill tone="ok">allow</Pill> <Pill tone="warn">review</Pill> or <Pill tone="danger">deny</Pill>.
            35 points or more means review, 70 or more deny; hard rules deny outright.
          </p>
          <ul className="doc-list">
            <li><b>Recipient:</b> deny list, malformed address for its chain, burn address, look-alike of a known recipient.</li>
            <li><b>Purpose:</b> too vague, or names a different address than the one being paid.</li>
            <li><b>Context:</b> hidden Unicode tags, zero-width and bidi characters, instruction overrides, secrecy demands, urgent payment demands, hidden HTML, encoded blobs.</li>
            <li><b>LLM (optional):</b> any OpenAI-compatible endpoint. It can only raise the score.</li>
          </ul>
          <p>
            <b>In the TEE.</b> <code>tee-oracle/</code> is the same logic in Rust, built for OutLayer and run inside Intel TDX. Verdicts are signed
            with a key the keystore derives inside the enclave; the code only sees signatures. You register its public key with
            <code>set_oracle</code>, and from then on every verdict the contract accepts was produced by that code. The gateway
            (<code>npm run gateway -w oracle</code>) serves the same API, pays for runs, and cannot forge a verdict.
          </p>
        </Sec>

        <Sec id="crosschain" title="Cross-chain payments">
          <p>
            For a recipient like <code>base:0xabc…</code> the MCP server gets a signed 1Click quote from NEAR Intents and pays its deposit address.
            The oracle's binding verifier checks the quote's signature, that the deposit address, recipient, chain, amount and refund address
            all match, and that no hidden fee skims more than 3%. A signed quote that fails is denied; no quote means the owner reviews it.
          </p>
          <p className="hint">1Click runs on mainnet only; the testnet run uses quotes signed by a test key, everything on-chain real.</p>
        </Sec>

        <Sec id="security" title="Security model">
          <ul className="doc-list">
            <li><b>Agent compromised:</b> it can only request. Limits, holds and the deny list still apply; you can pause or revoke it.</li>
            <li><b>Injected instructions:</b> the oracle reads the context; new recipients are held by default.</li>
            <li><b>Oracle compromised:</b> it can only make a payment execute that the policy already allows up to its caps. It never moves funds itself.</li>
            <li><b>Owner key:</b> holds the real power. Keep it in a wallet, not on the agent's machine.</li>
          </ul>
          <a className="btn secondary" href={`${REPO}/blob/main/docs/THREAT_MODEL.md`} target="_blank" rel="noreferrer">
            Full threat model <Icon name="arrowUpRight" size={14} />
          </a>
        </Sec>

        <Sec id="faq" title="FAQ">
          <div className="faq">
            {FAQ.map((f) => (
              <details key={f.q} className="faq-item">
                <summary>{f.q} <Icon name="chevronDown" size={16} /></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </Sec>

        <Sec id="glossary" title="Glossary">
          <dl className="glossary">
            {GLOSSARY.map(([t, d]) => (
              <div key={t}><dt>{t}</dt><dd>{d}</dd></div>
            ))}
          </dl>
        </Sec>
      </main>
    </div>
  );
}

function Sec(p: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={p.id} className="doc-sec" aria-labelledby={`${p.id}-h`}>
      <h2 id={`${p.id}-h`}>{p.title}</h2>
      {p.children}
    </section>
  );
}

function Card(p: { icon: "wallet" | "bot" | "scan" | "code"; title: string; children: ReactNode }) {
  return (
    <div className="doc-card">
      <span className="card-icon"><Icon name={p.icon} size={16} /></span>
      <b>{p.title}</b>
      <p>{p.children}</p>
    </div>
  );
}

const Pill = (p: { tone: "ok" | "warn" | "danger"; children: ReactNode }) => <span className={`badge ${p.tone}`}>{p.children}</span>;

const DEMO_POLICY = `{
  "tokens": {
    "near": {
      "max_per_tx": "1000000000000000000000000",
      "period_limit": "3000000000000000000000000",
      "approval_threshold": "500000000000000000000000",
      "attestation_threshold": null
    }
  },
  "period_secs": 86400,
  "max_requests_per_hour": 20,
  "allowed_recipients": null,
  "denied_recipients": [],
  "new_recipient_needs_approval": true,
  "pause_on_rate_limit": true
}`;
