// Small shared pieces: hash routing, scroll reveal, copyable code, the flow graphic.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

export type Route = "home" | "start" | "docs" | "app";

function readRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  if (h === "start" || h === "docs" || h === "app") return h;
  // Links without a route (?vault=6) open the dashboard directly.
  return !location.hash && new URLSearchParams(location.search).has("vault") ? "app" : "home";
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(readRoute);
  const current = useRef(route);
  useEffect(() => {
    // A new page starts at the top, however it was reached (link, back button, typed URL).
    const on = () => {
      const r = readRoute();
      if (r !== current.current) scrollTo({ top: 0 });
      current.current = r;
      setRoute(r);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = (r: Route) => {
    location.hash = r === "home" ? "/" : `/${r}`;
  };
  return [route, go];
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal(p: { children: ReactNode; delay?: number; as?: "div" | "section" | "li"; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !("IntersectionObserver" in window)) return setShown(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const Tag = (p.as ?? "div") as "div";
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      id={p.id}
      className={`reveal${shown ? " in" : ""}${p.className ? ` ${p.className}` : ""}`}
      style={{ transitionDelay: `${p.delay ?? 0}ms` }}
    >
      {p.children}
    </Tag>
  );
}

export function CodeBlock(p: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(p.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  return (
    <div className="code">
      <div className="code-bar">
        <span>{p.label ?? "Terminal"}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${p.label ?? "code"}`}>
          <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{p.code}</code>
      </pre>
    </div>
  );
}

/**
 * The hero graphic: an agent's payment requests flow into AgentGuard, which sends each
 * one to an outcome. Packets travel the wires with SMIL `animateMotion` (no JS per
 * frame); with reduced motion only the static diagram is drawn.
 */
export function FlowGraphic() {
  const [still] = useState(reducedMotion);
  const lanes = [
    { id: "ok", y: 70, label: "Paid", sub: "within policy", cls: "ok", dur: "4.2s", begin: "0s" },
    { id: "wait", y: 160, label: "Waits for you", sub: "new or large", cls: "warn", dur: "4.2s", begin: "1.4s" },
    { id: "no", y: 250, label: "Refused", sub: "over a limit", cls: "danger", dur: "4.2s", begin: "2.8s" },
  ];
  return (
    <div className="flow" aria-hidden>
      <svg viewBox="0 0 560 320" className="flow-svg">
        <defs>
          <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="flow-dot" />
          </pattern>
          <radialGradient id="glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" className="flow-glow-a" />
            <stop offset="100%" className="flow-glow-b" />
          </radialGradient>
        </defs>
        <rect width="560" height="320" fill="url(#dots)" opacity="0.6" />
        <circle cx="280" cy="160" r="120" fill="url(#glow)" className="flow-halo" />

        {/* wires: agent -> guard, guard -> outcomes */}
        <path id="w-in" d="M118 160 H232" className="wire" />
        {lanes.map((l) => (
          <path key={l.id} id={`w-${l.id}`} d={`M328 160 C 376 160, 376 ${l.y}, 416 ${l.y}`} className={`wire wire-${l.cls}`} />
        ))}

        {/* agent */}
        <g transform="translate(30 116)">
          <rect width="88" height="88" rx="20" className="node" />
          <g transform="translate(26 24)" className="node-ink">
            <rect x="2" y="10" width="32" height="24" rx="7" fill="none" strokeWidth="2.4" />
            <path d="M18 2v8M12 21h.01M24 21h.01" fill="none" strokeWidth="3" strokeLinecap="round" />
          </g>
          <text x="44" y="106" textAnchor="middle" className="node-label">AI agent</text>
        </g>

        {/* guard */}
        <g transform="translate(232 112)">
          <rect width="96" height="96" rx="24" className="node node-guard" />
          <g transform="translate(24 20)">
            <path d="M24 4l18 7v14c0 12-8 22-18 26-10-4-18-14-18-26V11z" className="guard-shield" />
            <path d="M16.5 37L24 18.5 31.5 37" className="guard-a" />
            <circle cx="24" cy="31.4" r="2.6" className="guard-dot" />
          </g>
          <text x="48" y="118" textAnchor="middle" className="node-label strong">AgentGuard</text>
        </g>

        {/* outcomes */}
        {lanes.map((l) => (
          <g key={l.id} transform={`translate(416 ${l.y - 24})`}>
            <rect width="132" height="48" rx="14" className={`node outcome outcome-${l.cls}`} />
            <circle cx="24" cy="24" r="11" className={`pip pip-${l.cls}`} />
            <text x="44" y="21" className="node-label strong" textAnchor="start">{l.label}</text>
            <text x="44" y="36" className="node-sub" textAnchor="start">{l.sub}</text>
          </g>
        ))}

        {!still &&
          lanes.map((l) => (
            <g key={`p-${l.id}`}>
              <circle r="5" className="packet">
                <animateMotion dur={l.dur} begin={l.begin} repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.3;1" calcMode="linear">
                  <mpath href="#w-in" />
                </animateMotion>
                <animate attributeName="opacity" dur={l.dur} begin={l.begin} repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.04;0.28;0.3;1" />
              </circle>
              <circle r="5" className={`packet packet-${l.cls}`}>
                <animateMotion dur={l.dur} begin={l.begin} repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;0.36;0.66;1" calcMode="linear">
                  <mpath href={`#w-${l.id}`} />
                </animateMotion>
                <animate attributeName="opacity" dur={l.dur} begin={l.begin} repeatCount="indefinite" values="0;0;1;1;0;0" keyTimes="0;0.35;0.37;0.64;0.68;1" />
              </circle>
            </g>
          ))}
      </svg>
    </div>
  );
}
