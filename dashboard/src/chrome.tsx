// Site header and footer, shared by every route.
import { useEffect, useState, type ReactNode } from "react";
import { Icon, Logo } from "./icons";
import { reducedMotion, type Route } from "./ui";

export const REPO = "https://github.com/CodeMasterLabs/agentguard";
const EXPLORER = { testnet: "https://testnet.nearblocks.io/address/", mainnet: "https://nearblocks.io/address/" };

/** Scrolls to a landing-page section, switching to the landing page first if needed. */
export function goSection(id: string, route: Route) {
  if (route !== "home") location.hash = "/";
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }), route === "home" ? 0 : 80);
}

export function Header(p: { route: Route; go: (r: Route) => void; walletArea: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [p.route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);

  const section = (id: string) => (setOpen(false), goSection(id, p.route));
  const inApp = p.route === "app" || p.route === "start";
  type Link = { label: string; current?: boolean; onClick: () => void; href: string };
  const docs: Link = { label: "Docs", href: "#/docs", current: p.route === "docs", onClick: () => p.go("docs") };
  const guide: Link = { label: "Setup guide", href: "#/start", current: p.route === "start", onClick: () => p.go("start") };
  const dash: Link = { label: "Dashboard", href: "#/app", current: p.route === "app", onClick: () => p.go("app") };
  // Inside the app the header is for moving between tools; on the site it explains the product.
  const links: Link[] = inApp
    ? [dash, guide, docs]
    : [
        { label: "How it works", href: "#/", onClick: () => section("how") },
        { label: "Try it", href: "#/", onClick: () => section("try") },
        { label: "Integrations", href: "#/", onClick: () => section("integrations") },
        docs,
        guide,
      ];

  return (
    <header className={`topbar${open ? " menu-open" : ""}`}>
      <div className="topbar-inner">
        <a className="brand" href="#/" onClick={(e) => (e.preventDefault(), p.go("home"))} aria-label="AgentGuard home">
          <Logo />
          <b>AgentGuard</b>
        </a>
        <nav className="nav-links" aria-label="Main">
          {links.map((l) => (
            <a key={l.label} href={l.href} aria-current={l.current ? "page" : undefined} onClick={(e) => (e.preventDefault(), l.onClick())}>
              {l.label}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <a className="btn ghost icon-only gh hide-md" href={REPO} target="_blank" rel="noreferrer" aria-label="AgentGuard on GitHub" title="GitHub">
          <Icon name="github" size={18} />
        </a>
        {inApp ? (
          p.walletArea
        ) : (
          <button className="btn" onClick={() => p.go("app")}>
            Open app <Icon name="arrowRight" size={15} />
          </button>
        )}
        <button
          className="btn ghost icon-only menu-btn"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? "x" : "menu"} size={18} />
        </button>
      </div>
      {open && (
        <div id="site-menu" className="menu-sheet">
          <nav aria-label="Menu">
            {links.map((l) => (
              <a key={l.label} href={l.href} aria-current={l.current ? "page" : undefined} onClick={(e) => (e.preventDefault(), l.onClick(), setOpen(false))}>
                {l.label} <Icon name="arrowRight" size={15} />
              </a>
            ))}
            {!inApp && (
              <a href="#/app" onClick={(e) => (e.preventDefault(), p.go("app"))}>
                Dashboard <Icon name="arrowRight" size={15} />
              </a>
            )}
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub <Icon name="arrowUpRight" size={15} />
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}

export function Footer(p: { route: Route; go: (r: Route) => void; onDemo: () => void; contract: string; network: "testnet" | "mainnet" }) {
  const top = () => scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  const bottom = (
    <div className="foot-bottom">
      <span>© 2026 AgentGuard · MIT License · open source</span>
      <div className="foot-bottom-r">
        <a href={`${EXPLORER[p.network]}${p.contract}`} target="_blank" rel="noreferrer" className="mono">
          {p.contract} <Icon name="arrowUpRight" size={12} />
        </a>
        <button type="button" className="linkbtn" onClick={top}>Back to top ↑</button>
      </div>
    </div>
  );
  // The dashboard is a tool: a slim footer keeps the focus on the vault.
  if (p.route === "app") return <footer className="site-foot slim">{bottom}</footer>;

  const doc = (id: string) => `#/docs/${id}`;
  const cols: { title: string; links: { label: string; href: string; onClick?: () => void; ext?: boolean }[] }[] = [
    {
      title: "Product",
      links: [
        { label: "How it works", href: "#/", onClick: () => goSection("how", p.route) },
        { label: "Try an attack", href: "#/", onClick: () => goSection("try", p.route) },
        { label: "Integrations", href: "#/", onClick: () => goSection("integrations", p.route) },
        { label: "Live demo vault", href: "#/app", onClick: p.onDemo },
        { label: "Setup guide", href: "#/start", onClick: () => p.go("start") },
        { label: "Dashboard", href: "#/app", onClick: () => p.go("app") },
      ],
    },
    {
      title: "Developers",
      links: [
        { label: "Quickstart", href: doc("quickstart") },
        { label: "Policy reference", href: doc("policy") },
        { label: "MCP tools", href: doc("mcp") },
        { label: "Risk oracle and TEE", href: doc("oracle") },
        { label: "Security model", href: doc("security") },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "Source code", href: REPO, ext: true },
        { label: "Threat model", href: `${REPO}/blob/main/docs/THREAT_MODEL.md`, ext: true },
        { label: "Testnet report", href: `${REPO}/blob/main/docs/TESTNET.md`, ext: true },
        { label: "TEE oracle build", href: "https://github.com/CodeMasterLabs/agentguard-tee-oracle/releases/tag/v0.1.0", ext: true },
        { label: "Report an issue", href: `${REPO}/issues`, ext: true },
      ],
    },
  ];

  return (
    <footer className="site-foot">
      <div className="foot-main">
        <div className="foot-brand-col">
          <a className="brand" href="#/" onClick={(e) => (e.preventDefault(), p.go("home"))}>
            <Logo /> <b>AgentGuard</b>
          </a>
          <p>A spending firewall for AI agents on NEAR. Give your agent a budget, not your keys.</p>
          <span className="badge ok"><span className="pulse" /> Live on NEAR testnet</span>
          <div className="foot-built">
            <span>Built with</span>
            <ul>
              {["NEAR", "OutLayer", "NEAR Intents", "MCP"].map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        </div>
        {cols.map((c) => (
          <nav key={c.title} className="foot-col" aria-label={c.title}>
            <h2>{c.title}</h2>
            <ul>
              {c.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...(l.ext ? { target: "_blank", rel: "noreferrer" } : {})}
                    onClick={l.onClick ? (e) => (e.preventDefault(), l.onClick!()) : undefined}
                  >
                    {l.label} {l.ext && <Icon name="arrowUpRight" size={12} />}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      {bottom}
    </footer>
  );
}
