// Stroke icons drawn on a 24px grid (Lucide's geometry), inlined so the dashboard
// ships no icon library. Decorative by default; pass a label to expose one.
import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  shield: <path d="M12 3l7 2.6v5.6c0 4.5-3 8.4-7 9.8-4-1.4-7-5.3-7-9.8V5.6z" />,
  shieldCheck: (
    <>
      <path d="M12 3l7 2.6v5.6c0 4.5-3 8.4-7 9.8-4-1.4-7-5.3-7-9.8V5.6z" />
      <path d="M9 12l2 2 4-4.5" />
    </>
  ),
  shieldOff: (
    <>
      <path d="M12 3l7 2.6v5.6c0 4.5-3 8.4-7 9.8-4-1.4-7-5.3-7-9.8V5.6z" />
      <path d="M10 9.5v5M14 9.5v5" />
    </>
  ),
  power: (
    <>
      <path d="M12 3v8" />
      <path d="M6.4 7.4a8 8 0 1 0 11.2 0" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2.5" />
      <path d="M3 10h18M16.5 14.5h.01" />
      <path d="M6 6l9.5-3 1 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5l9.5 16.5h-19z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUpRight: <path d="M7 17L17 7M8 7h9v9" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  logOut: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l-5-5 5-5M5 12h11" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 12h8" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13l3-8h12l3 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </>
  ),
  code: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      className="icon"
    >
      {paths[name]}
    </svg>
  );
}

/** The AgentGuard mark: a shield with a check. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <rect width="32" height="32" rx="8" className="logo-bg" />
      <path d="M16 6l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V9z" fill="none" className="logo-fg" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M12.5 16l2.5 2.5 4.5-5" fill="none" className="logo-fg" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
