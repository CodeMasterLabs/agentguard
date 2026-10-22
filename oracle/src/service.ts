import { attestationMessage, type Attestation, type SpendRequest, type Verdict } from "@agentguard/sdk";
import { llmRisk, type LlmConfig } from "./llm.js";
import { assess, splitRecipient, type RulesConfig } from "./rules.js";
import type { Signal } from "./injection.js";
import type { OracleSigner } from "./signer.js";

export interface VerdictInput {
  contract_id: string;
  vault_id: number;
  request: SpendRequest;
  context?: string;
}

export interface OracleDeps {
  signer: OracleSigner;
  rules: RulesConfig;
  ttlSecs: number;
  /** If set, only sign for these contract ids. */
  allowedContracts?: Set<string>;
  llm?: LlmConfig;
  /**
   * Proves a cross-chain `pay_to` (an Intents deposit address) really pays `recipient`.
   * Without one, cross-chain requests are never auto-allowed.
   */
  verifyBinding?: (req: SpendRequest) => Promise<boolean>;
  now?: () => number;
}

export interface Decision {
  attestation: Attestation;
  verdict: Verdict;
  score: number;
  signals: Signal[];
}

export class InputError extends Error {}

export function parseInput(body: unknown): VerdictInput {
  const b = body as Partial<VerdictInput>;
  const r = b?.request as Partial<SpendRequest> | undefined;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (!str(b?.contract_id) || !Number.isInteger(b?.vault_id) || (b!.vault_id as number) < 0) {
    throw new InputError("contract_id and vault_id are required");
  }
  if (!r || !str(r.token) || !/^\d+$/.test(String(r.amount)) || !str(r.recipient) || !str(r.pay_to) ||
      typeof r.purpose !== "string" || !Number.isInteger(r.nonce) || !String(r.recipient).includes(":")) {
    throw new InputError("request must have token, amount (integer string), recipient (<chain>:<address>), pay_to, purpose, nonce");
  }
  if (b.context !== undefined && typeof b.context !== "string") throw new InputError("context must be a string");
  return { contract_id: b.contract_id!, vault_id: b.vault_id!, request: r as SpendRequest, context: b.context };
}

export async function decide(input: VerdictInput, deps: OracleDeps): Promise<Decision> {
  if (deps.allowedContracts && !deps.allowedContracts.has(input.contract_id)) {
    throw new InputError(`this oracle does not sign for ${input.contract_id}`);
  }
  const req = input.request;
  const context = input.context ?? "";
  const a = assess(req, context, deps.rules);
  const signals = [...a.signals];

  if (deps.llm && context.trim()) {
    try {
      const { risk, reason } = await llmRisk(deps.llm, req, context);
      if (risk >= deps.rules.reviewAt) signals.push({ id: "llm_flagged", points: risk, detail: reason });
    } catch (e) {
      signals.push({ id: "llm_unavailable", points: 0, detail: String(e) });
    }
  }

  const [chain] = splitRecipient(req.recipient);
  if (chain !== "near") {
    const bound = deps.verifyBinding ? await deps.verifyBinding(req).catch(() => false) : false;
    if (!bound) signals.push({ id: "cross_chain_binding_unverified", points: deps.rules.reviewAt });
  }

  const score = signals.reduce((s, x) => s + x.points, 0);
  const verdict: Verdict = score >= deps.rules.denyAt ? "deny" : score >= deps.rules.reviewAt ? "review" : "allow";
  const nowMs = (deps.now ?? Date.now)();
  const expiresAt = ((BigInt(nowMs) + BigInt(deps.ttlSecs) * 1000n) * 1_000_000n).toString();
  const message = attestationMessage(input.contract_id, input.vault_id, req, verdict, expiresAt);
  return {
    attestation: { verdict, expires_at: expiresAt, signature: deps.signer.sign(message) },
    verdict,
    score,
    signals,
  };
}
