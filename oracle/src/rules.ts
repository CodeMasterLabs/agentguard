import type { SpendRequest, Verdict } from "@agentguard/sdk";
import { scanContext, type Signal } from "./injection.js";

export interface RulesConfig {
  /** `chain:address` or bare addresses / NEAR accounts, matched case-insensitively. */
  denylist: Set<string>;
  /** Recipients the owner already trusts, used to catch look-alike (poisoned) addresses. */
  knownRecipients: string[];
  denyAt: number;
  reviewAt: number;
}

export interface Assessment {
  verdict: Verdict;
  score: number;
  signals: Signal[];
}

const EVM_CHAINS = new Set(["eth", "ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche", "gnosis", "aurora"]);
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_ADDR = /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BURN = /^0x0{40}$|^0x0{36}dead$/i;
const ADDRESS_IN_TEXT = /\b0x[0-9a-fA-F]{40}\b|\b[a-z\d_-]{2,64}\.(near|testnet)\b/gi;

export function splitRecipient(recipient: string): [chain: string, address: string] {
  const i = recipient.indexOf(":");
  return [recipient.slice(0, i).toLowerCase(), recipient.slice(i + 1)];
}

function addressShapeOk(chain: string, addr: string): boolean {
  if (EVM_CHAINS.has(chain)) return EVM_ADDR.test(addr);
  if (chain === "solana" || chain === "sol") return SOLANA_ADDR.test(addr);
  if (chain === "bitcoin" || chain === "btc") return BTC_ADDR.test(addr);
  if (chain === "near") return addr.length >= 2 && addr.length <= 64 && NEAR_ACCOUNT.test(addr);
  return addr.length > 0; // unknown chain: no shape rule
}

/** Same head and tail, different middle: the shape of an address-poisoning attack. */
export function isLookalike(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^0x/, "");
  const y = b.toLowerCase().replace(/^0x/, "");
  return x !== y && x.length >= 12 && x.length === y.length && x.slice(0, 4) === y.slice(0, 4) && x.slice(-4) === y.slice(-4);
}

export function assess(req: SpendRequest, context: string, cfg: RulesConfig): Assessment {
  const [chain, addr] = splitRecipient(req.recipient);
  const signals: Signal[] = [];
  const HARD = 1000;

  const listed = [req.recipient, addr, req.pay_to, `near:${req.pay_to}`].map((s) => s.toLowerCase());
  if (listed.some((s) => cfg.denylist.has(s))) signals.push({ id: "denylisted", points: HARD });
  if (!addressShapeOk(chain, addr)) signals.push({ id: "malformed_address", points: HARD, detail: chain });
  if (BURN.test(addr)) signals.push({ id: "burn_address", points: HARD });

  for (const known of cfg.knownRecipients) {
    const [kc, ka] = splitRecipient(known);
    if (kc === chain && isLookalike(addr, ka)) {
      signals.push({ id: "lookalike_of_known_recipient", points: HARD, detail: known });
      break;
    }
  }

  if (req.purpose.trim().length < 8) signals.push({ id: "vague_purpose", points: 10 });
  const mentioned = req.purpose.match(ADDRESS_IN_TEXT) ?? [];
  if (mentioned.some((m) => m.toLowerCase() !== addr.toLowerCase() && m.toLowerCase() !== req.pay_to.toLowerCase())) {
    // On its own enough for a human look: the agent says it pays X but sends to Y.
    signals.push({ id: "purpose_names_other_address", points: 35 });
  }

  signals.push(...scanContext(context, addr));
  const score = signals.reduce((s, x) => s + x.points, 0);
  const verdict: Verdict = score >= cfg.denyAt ? "deny" : score >= cfg.reviewAt ? "review" : "allow";
  return { verdict, score, signals };
}
