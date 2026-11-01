// The landing page: what AgentGuard is, the problem it solves, who it is for and how to start.
import { Icon, type IconName } from "./icons";
import { BrandLogo, type BrandId } from "./logos";
import { lazy, Suspense, useRef, useState } from "react";
import { FlowGraphic, Reveal } from "./ui";

// Bundles the oracle's rules, so it loads after the hero, not with it.
const Playground = lazy(() => import("./playground").then((m) => ({ default: m.Playground })));

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Does the agent ever hold my funds?",
    a: "No. Funds sit in a vault inside the AgentGuard contract. The agent's account has a single function-call key that can only call request_spend, and pays its own gas from a small allowance. It cannot transfer, add keys or call any other contract.",
  },
  {
    q: "What happens when a payment breaks the rules?",
    a: "It never leaves the vault. Hard limits (per-payment cap, period budget, deny list, rate limit) refuse it with a reason the agent can read. Softer cases, like a first payment to a new address or an amount above your auto-approve line, wait in your approval queue.",
  },
  {
    q: "What does the TEE risk oracle add?",
    a: "Rules see amounts and addresses; they cannot see why the agent wants to pay. The oracle reads the text that led to the payment (an email, a web page, a tool result) and signs allow, review or deny. It runs inside Intel TDX on OutLayer with a key no one holds, so a verdict the contract accepts was made by that exact code.",
  },
  {
    q: "Do I need the oracle?",
    a: "No. Without it the policy still enforces every limit. You can require a verdict only above a chosen amount, so small payments stay fast and large ones get a second look.",
  },
  {
    q: "Which agents work with it?",
    a: "Any agent that speaks MCP (Claude, Cursor, custom agents) through the bundled MCP server, or any TypeScript code through the SDK. Payments can go to NEAR accounts or, through NEAR Intents, to addresses on other chains.",
  },
  {
    q: "Is it live?",
    a: "Yes, on NEAR testnet, with a public demo vault you can open without a wallet. The contract, SDK, MCP server and oracle are open source.",
  },
];

const PROBLEMS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "alert",
    title: "Prompt injection",
    body: "A hidden line in an email or web page tells the agent to \"pay this invoice now\". The agent cannot tell the difference between your instruction and an attacker's.",
  },
  {
    icon: "clock",
    title: "Runaway loops",
    body: "A retry bug or a confused plan sends the same payment again and again. With a raw key, nothing stops it until the wallet is empty.",
  },
  {
    icon: "scan",
    title: "Look-alike addresses",
    body: "Address poisoning puts a near-copy of a known payee in the agent's history. One wrong character and the money is gone for good.",
  },
];

const PILLARS: { icon: IconName; title: string; body: string }[] = [
  { icon: "wallet", title: "A vault, not a wallet", body: "You fund a vault you own. The agent can ask to spend from it, never touch it." },
  { icon: "shieldCheck", title: "A policy on-chain", body: "Caps per payment, budgets per period, rate limits, allow and deny lists. Enforced by the contract." },
  { icon: "scan", title: "A risk oracle in a TEE", body: "Reads the text behind each payment and signs a verdict the contract can verify." },
  { icon: "power", title: "You stay in charge", body: "Approve or reject what is held, pause instantly from any key, withdraw at any time." },
];

const INTEGRATIONS: { logo: BrandId; name: string; role: string; body: string; href: string }[] = [
  { logo: "near", name: "NEAR Protocol", role: "Chain", body: "The vault contract is Rust on near-sdk. Policy, approvals and the kill switch are enforced on-chain.", href: "https://near.org" },
  { logo: "outlayer", name: "OutLayer", role: "TEE", body: "Runs the risk oracle inside Intel TDX. Its signing key is derived in the enclave and never leaves it.", href: "https://outlayer.ai" },
  { logo: "intents", name: "NEAR Intents Ã‚Â· 1Click", role: "Cross-chain", body: "Pays recipients on Base, Ethereum, Solana and more. Every quote is checked before funds move.", href: "https://docs.near-intents.org" },
  { logo: "mcp", name: "Model Context Protocol", role: "Agents", body: "Four tools any MCP client can call: Claude, Cursor or your own agent. No custom integration needed.", href: "https://modelcontextprotocol.io" },
  { logo: "hot", name: "NEAR Connect", role: "Wallets", body: "HOT Labs' wallet connector. Owners sign in with HOT, Meteor, MyNearWallet and more to approve, pause and withdraw.", href: "https://github.com/hot-dao/near-selector" },
  { logo: "nearai", name: "NEAR AI Cloud", role: "Optional LLM", body: "An extra model pass in the oracle over any OpenAI-compatible endpoint. It can only raise risk, never lower it.", href: "https://near.ai" },
];

/** Moves the card's spotlight to the pointer. CSS variables only, so no re-render. */
function spot(e: React.PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
}

const STEPS: { title: string; body: string }[] = [
  { title: "The agent asks", body: "It calls agentguard_pay with a token, amount, recipient and purpose, plus the text that made it want to pay." },
  { title: "The oracle reads the context", body: "Optional. Inside the TEE it scores injection signals, malformed or look-alike addresses and vague purposes, then signs a verdict." },
  { title: "The contract decides", body: "Hard limits first, then the softer checks. Every rule and the verdict signature are checked on-chain, in one transaction." },
  { title: "Paid, held or refused", body: "Within policy, the funds move at once. Otherwise the payment waits for you, or is refused with a reason the agent can read." },
];

const AUDIENCE: { icon: IconName; title: string; body: string }[] = [
  { icon: "code", title: "Agent builders", body: "Ship agents that pay for APIs, compute and services without handing them a private key." },
  { icon: "user", title: "Teams and DAOs", body: "Give an agent a budget the way you would give a card to a new hire: a limit, a log and a kill switch." },
  { icon: "bot", title: "People using AI assistants", body: "Let Claude or another MCP client run errands that cost money, and approve anything unusual from your phone." },
];

/** The recorded demo: poster + a play button until the first play, then the browser controls. */
function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  return (
    <div className="video-frame">
      <video
        ref={ref}
        controls
        playsInline
        preload="none"
        poster="/agentguard-demo-poster.jpg"
        width={1920}
        height={1080}
        aria-label="AgentGuard demo: a recorded run on NEAR testnet, 1 minute 56 seconds"
        onPlay={() => setStarted(true)}
      >
        <source src="/agentguard-demo.mp4" type="video/mp4" />
        Your browser cannot play this video. <a href="/agentguard-demo.mp4">Download the MP4</a> instead.
      </video>
      {!started && (
        <button className="video-play" onClick={() => ref.current?.play()}>
          <span className="video-play-icon" aria-hidden>▶</span>
          <span className="video-play-label">Watch the demo · 1:56</span>
        </button>
      )}
    </div>
  );
}

export function Landing(p: { onStart: () => void; onDocs: () => void; onDemo: () => void }) {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <main id="main" tabIndex={-1} className="landing">
      {/* ---------- hero ---------- */}
      <section className="hero">
        <div className="hero-bg" aria-hidden>
          <div className="hero-grid" />
          <div className="hero-glow" />
        </div>
        <div className="hero-copy">
          <span className="badge ok enter" style={{ animationDelay: "0ms" }}><span className="pulse" /> Live on NEAR testnet</span>
          <h1 className="enter rise" style={{ animationDelay: "80ms" }}>
            Give your AI agent a budget,
            <br />
            <em>not your keys.</em>
          </h1>
          <p className="lede enter rise" style={{ animationDelay: "160ms" }}>
            AgentGuard is a spending firewall for AI agents on NEAR. Every payment your agent asks for is checked against
            your rules and a tamper-proof risk oracle. It goes through, waits for you, or is refused.
          </p>
          <div className="cta enter" style={{ animationDelay: "240ms" }}>
            <button className="btn lg" onClick={p.onStart}>
              Set up a vault <Icon name="arrowRight" />
            </button>
            <button className="btn lg secondary" onClick={p.onDemo}>
              See the live demo
            </button>
          </div>
          <p className="hero-note enter" style={{ animationDelay: "320ms" }}>
            Open source Ã‚Â· about 5 minutes to set up Ã‚Â· no wallet needed to explore
          </p>
        </div>
        <div className="hero-art enter" style={{ animationDelay: "200ms" }}>
          <FlowGraphic />
        </div>
        <div className="built-on enter" style={{ animationDelay: "420ms" }}>
          <span>Built on</span>
          <ul>
            {["NEAR Protocol", "OutLayer TEE", "Intel TDX", "NEAR Intents", "MCP"].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------- demo video ---------- */}
      <section id="demo" className="section" aria-labelledby="demo-h">
        <Reveal className="section-head center">
          <span className="eyebrow">Demo</span>
          <h2 id="demo-h">Two minutes, one poisoned invoice.</h2>
          <p>
            A recorded run on NEAR testnet: an injected invoice is refused, a payment waits for the owner, and
            the kill switch stops everything.
          </p>
        </Reveal>
        <Reveal>
          <DemoVideo />
        </Reveal>
        <p className="video-note">1:56 Â· recorded on NEAR testnet Â· no wallet needed to watch</p>
      </section>

      {/* ---------- problem ---------- */}
      <section id="why" className="section" aria-labelledby="why-h">
        <Reveal className="section-head">
          <span className="eyebrow">Why it exists</span>
          <h2 id="why-h">An agent with a private key can spend everything, for anyone who can talk to it.</h2>
          <p>
            Agents now book, buy and pay on their own. To do that they need money, and today that usually means a hot
            wallet key. Whoever controls the agent's inputs controls that wallet.
          </p>
        </Reveal>
        <div className="cards three">
          {PROBLEMS.map((x, i) => (
            <Reveal key={x.title} delay={i * 90} className="card problem">
              <span className="card-icon danger"><Icon name={x.icon} size={18} /></span>
              <h3>{x.title}</h3>
              <p>{x.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- what it is ---------- */}
      <section id="product" className="section" aria-labelledby="what-h">
        <Reveal className="section-head">
          <span className="eyebrow">What it is</span>
          <h2 id="what-h">The same controls a company card has, enforced by a smart contract.</h2>
          <p>AgentGuard sits between your agent and your money. Four pieces work together:</p>
        </Reveal>
        <div className="cards four">
          {PILLARS.map((x, i) => (
            <Reveal key={x.title} delay={i * 80} className="card">
              <span className="card-icon"><Icon name={x.icon} size={18} /></span>
              <h3>{x.title}</h3>
              <p>{x.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="how" className="section" aria-labelledby="how-h">
        <Reveal className="section-head">
          <span className="eyebrow">How it works</span>
          <h2 id="how-h">One payment, start to finish.</h2>
        </Reveal>
        <ol className="timeline">
          {STEPS.map((s, i) => (
            <Reveal as="li" key={s.title} delay={i * 110} className="tl-step">
              <span className="tl-num num">{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
        <Reveal className="outcomes">
          <div className="outcome-card ok">
            <Icon name="check" size={16} /> <b>Paid</b> <span>within every limit</span>
          </div>
          <div className="outcome-card warn">
            <Icon name="clock" size={16} /> <b>Held</b> <span>new recipient, large amount, oracle asks for review</span>
          </div>
          <div className="outcome-card danger">
            <Icon name="x" size={16} /> <b>Refused</b> <span>over a cap, deny-listed, oracle says deny, paused</span>
          </div>
        </Reveal>
      </section>

      {/* ---------- playground ---------- */}
      <section id="try" className="section" aria-labelledby="try-h">
        <Reveal className="section-head">
          <span className="eyebrow">Try it</span>
          <h2 id="try-h">Try to trick it.</h2>
          <p>
            Pick an attack or write your own. You'll see what the risk oracle flags and what the vault does with the payment, using the
            same rules that run in the TEE.
          </p>
        </Reveal>
        <Suspense fallback={<div className="pg-loading panel" aria-busy="true" />}>
          <Playground />
        </Suspense>
      </section>

      {/* ---------- integrations ---------- */}
      <section id="integrations" className="section" aria-labelledby="int-h">
        <Reveal className="section-head">
          <span className="eyebrow">Integrations</span>
          <h2 id="int-h">Built on open infrastructure you can verify.</h2>
          <p>AgentGuard does not reinvent custody, enclaves or bridges. It connects proven pieces of the NEAR ecosystem and checks each one.</p>
        </Reveal>
        <div className="int-grid">
          {INTEGRATIONS.map((x, i) => (
            <Reveal key={x.name} delay={(i % 3) * 80}>
              <a className="int" href={x.href} target="_blank" rel="noreferrer" onPointerMove={spot}>
                <span className={`int-icon brand-tile ${x.logo}`}><BrandLogo id={x.logo} /></span>
                <span className="int-index num" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
                <span className="int-text">
                  <span className="int-role">{x.role}</span>
                  <b>
                    {x.name} <Icon name="arrowUpRight" size={14} />
                  </b>
                  <p>{x.body}</p>
                </span>
              </a>
            </Reveal>
          ))}
        </div>
        <p className="tm-note">Logos are trademarks of their respective owners and are shown to identify the services AgentGuard works with.</p>
      </section>

      {/* ---------- who ---------- */}
      <section id="who" className="section" aria-labelledby="who-h">
        <Reveal className="section-head">
          <span className="eyebrow">Who it is for</span>
          <h2 id="who-h">Anyone who wants an agent to pay without trusting it blindly.</h2>
        </Reveal>
        <div className="cards three">
          {AUDIENCE.map((x, i) => (
            <Reveal key={x.title} delay={i * 90} className="card">
              <span className="card-icon"><Icon name={x.icon} size={18} /></span>
              <h3>{x.title}</h3>
              <p>{x.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- get started ---------- */}
      <section id="get-started" className="section" aria-labelledby="start-h">
        <Reveal className="start-band">
          <div>
            <span className="eyebrow">Get started</span>
            <h2 id="start-h">From zero to a guarded agent in five steps.</h2>
            <p>The setup guide walks you through each one and fills in the commands for you.</p>
            <div className="cta">
              <button className="btn lg" onClick={p.onStart}>
                Start the setup guide <Icon name="arrowRight" />
              </button>
              <button className="btn lg ghost" onClick={p.onDocs}>
                Read the docs
              </button>
            </div>
          </div>
          <ol className="mini-steps">
            {["Connect your NEAR wallet", "Create a vault with a policy", "Give your agent a limited key", "Plug the agent in over MCP", "Approve what it asks for"].map((t, i) => (
              <li key={t}>
                <span className="num">{i + 1}</span> {t}
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      {/* ---------- faq ---------- */}
      <section id="faq" className="section narrow" aria-labelledby="faq-h">
        <Reveal className="section-head center">
          <span className="eyebrow">FAQ</span>
          <h2 id="faq-h">Questions people ask first.</h2>
        </Reveal>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.q} className="faq-item">
              <summary>
                {f.q} <Icon name="chevronDown" size={16} />
              </summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
      </section>

      {/* ---------- final cta ---------- */}
      <section className="section">
        <Reveal className="final">
          <h2>Let your agent spend. Keep the last word.</h2>
          <div className="cta center">
            <button className="btn lg" onClick={p.onStart}>
              Set up a vault <Icon name="arrowRight" />
            </button>
            <button className="btn lg secondary" onClick={p.onDemo}>
              Open the demo vault
            </button>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
