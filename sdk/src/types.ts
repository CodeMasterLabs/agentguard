// Mirrors the contract's JSON types (contract/src/policy.rs, lib.rs).
// u128 amounts travel as decimal strings; timestamps are nanosecond strings.

export const NATIVE = "near";

export interface TokenLimits {
  max_per_tx: string;
  period_limit: string;
  approval_threshold: string;
  attestation_threshold: string | null;
}

export interface Policy {
  tokens: Record<string, TokenLimits>;
  period_secs: number;
  max_requests_per_hour: number;
  allowed_recipients: string[] | null;
  denied_recipients: string[];
  new_recipient_needs_approval: boolean;
  pause_on_rate_limit: boolean;
}

export interface SpendRequest {
  token: string;
  amount: string;
  /** `<chain>:<address>`, e.g. `near:bob.near` or `base:0xabc…` */
  recipient: string;
  /** NEAR account that receives the funds (an Intents deposit address for other chains). */
  pay_to: string;
  purpose: string;
  nonce: number;
}

export type Verdict = "allow" | "review" | "deny";

export interface Attestation {
  verdict: Verdict;
  expires_at: string;
  signature: string;
}

export type Reason =
  | "paused"
  | "token_not_allowed"
  | "zero_amount"
  | "recipient_denied"
  | "recipient_not_allowed"
  | "rate_limited"
  | "over_per_tx_cap"
  | "over_period_limit"
  | "oracle_denied"
  | "bad_attestation"
  | "insufficient_balance"
  | "pending_queue_full"
  | "oracle_review"
  | "over_approval_threshold"
  | "needs_attestation"
  | "cross_chain_needs_attestation"
  | "new_recipient";

export type SpendResult =
  | { status: "executed"; nonce: number }
  | { status: "pending"; pending_id: number; reason: Reason }
  | { status: "denied"; reason: Reason };

export interface PendingSpend {
  id: number;
  request: SpendRequest;
  reason: Reason;
  created_at: string;
}

export interface Usage {
  period_start: string;
  spent: Record<string, string>;
  hour_start: string;
  hour_requests: number;
}

export interface Vault {
  owner: string;
  agent: string | null;
  oracle_pk: string | null;
  policy: Policy;
  usage: Usage;
  balances: Record<string, string>;
  paused: boolean;
  nonce: number;
  pending: PendingSpend[];
  next_pending_id: number;
}

/** Plain-English explanation per reason, for agents and dashboards. */
export const REASON_TEXT: Record<Reason, string> = {
  paused: "The vault is paused by its owner or by the rate limiter.",
  token_not_allowed: "This token is not in the vault's policy.",
  zero_amount: "Amount must be greater than zero.",
  recipient_denied: "This recipient is on the deny list.",
  recipient_not_allowed: "This recipient is not on the allow list.",
  rate_limited: "Too many spend requests this hour.",
  over_per_tx_cap: "Amount is above the per-transaction cap.",
  over_period_limit: "This would exceed the spending limit for the current period.",
  oracle_denied: "The risk oracle flagged this payment as unsafe.",
  bad_attestation: "The risk verdict was invalid, expired, or for a different request.",
  insufficient_balance: "The vault does not hold enough of this token.",
  pending_queue_full: "Too many payments are already waiting for approval.",
  oracle_review: "The risk oracle wants a human to review this payment.",
  over_approval_threshold: "Amount is above the auto-approve threshold; waiting for the owner.",
  needs_attestation: "Amount needs a risk-oracle verdict; waiting for the owner.",
  cross_chain_needs_attestation: "Cross-chain payment without a risk verdict; waiting for the owner.",
  new_recipient: "First payment to this recipient; waiting for the owner.",
};
