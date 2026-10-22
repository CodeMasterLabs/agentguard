//! Pure policy evaluation. No env access here so every rule is unit-testable.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};
use std::collections::BTreeMap;

/// Token id used for native NEAR. Every other token id is a NEP-141 contract account.
pub const NATIVE: &str = "near";
pub const NANOS_PER_SEC: u64 = 1_000_000_000;
pub const HOUR_NS: u64 = 3600 * NANOS_PER_SEC;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimits {
    /// Hard cap for a single spend. Larger requests are denied outright.
    pub max_per_tx: U128,
    /// Total the agent may spend per `Policy::period_secs`.
    pub period_limit: U128,
    /// Spends strictly above this wait for the owner's approval.
    pub approval_threshold: U128,
    /// Spends at or above this need a signed risk-oracle verdict. `None` = never required.
    pub attestation_threshold: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Token allowlist with per-token limits. A token missing here cannot be spent.
    pub tokens: BTreeMap<String, TokenLimits>,
    /// Length of the spending window used by `period_limit`.
    pub period_secs: u64,
    /// Max spend requests (any outcome) per rolling hour bucket. Stops runaway loops.
    pub max_requests_per_hour: u32,
    /// When set, only these recipients may be paid.
    pub allowed_recipients: Option<Vec<String>>,
    pub denied_recipients: Vec<String>,
    /// First payment to a recipient this vault never paid before waits for approval.
    pub new_recipient_needs_approval: bool,
    /// Pause the whole vault when the rate limit trips.
    pub pause_on_rate_limit: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub period_start: U64,
    pub spent: BTreeMap<String, U128>,
    pub hour_start: U64,
    pub hour_requests: u32,
}

impl Usage {
    /// Reset windows whose time has passed.
    pub fn roll(&mut self, now: u64, period_secs: u64) {
        if now.saturating_sub(self.period_start.0) >= period_secs.saturating_mul(NANOS_PER_SEC) {
            self.period_start = U64(now);
            self.spent.clear();
        }
        if now.saturating_sub(self.hour_start.0) >= HOUR_NS {
            self.hour_start = U64(now);
            self.hour_requests = 0;
        }
    }

    pub fn spent_of(&self, token: &str) -> u128 {
        self.spent.get(token).map(|v| v.0).unwrap_or(0)
    }

    pub fn add_spent(&mut self, token: &str, amount: u128) {
        let total = self.spent_of(token).saturating_add(amount);
        self.spent.insert(token.to_string(), U128(total));
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendRequest {
    /// `"near"` or a NEP-141 contract id.
    pub token: String,
    pub amount: U128,
    /// Final beneficiary as `<chain>:<address>`, e.g. `near:bob.near` or `base:0xAbC…`.
    /// Policies (allow/deny lists, known recipients) match against this string.
    pub recipient: String,
    /// NEAR account that actually receives the funds. Equal to the address for `near:`
    /// recipients; for other chains it is a NEAR Intents deposit address, and the
    /// oracle verdict is what binds it to `recipient`.
    pub pay_to: AccountId,
    /// Why the agent is spending. Logged in events, hashed into attestations.
    pub purpose: String,
    /// Must equal the vault's current nonce. Makes oracle verdicts single-use.
    pub nonce: u64,
}

/// The form recipients are compared in: chain lowercased, and hex (`0x…`) addresses
/// lowercased, since EVM addresses are case-insensitive (EIP-55 case is only a checksum).
/// Without this, `base:0xABC…` would slip past a deny list holding `base:0xabc…`.
/// Base58 and bech32 addresses are left alone: their case is significant or fixed.
pub fn canonical_recipient(recipient: &str) -> String {
    match recipient.split_once(':') {
        Some((chain, addr)) if addr.starts_with("0x") || addr.starts_with("0X") => {
            format!("{}:{}", chain.to_lowercase(), addr.to_lowercase())
        }
        Some((chain, addr)) => format!("{}:{addr}", chain.to_lowercase()),
        None => recipient.to_string(),
    }
}

impl SpendRequest {
    pub fn canonical_recipient(&self) -> String {
        canonical_recipient(&self.recipient)
    }

    pub fn recipient_chain(&self) -> &str {
        self.recipient.split(':').next().unwrap_or("")
    }

    pub fn is_cross_chain(&self) -> bool {
        self.recipient_chain() != "near"
    }

    /// Shape checks that do not depend on the policy.
    pub fn validate(&self) -> Result<(), &'static str> {
        let Some((chain, addr)) = self.recipient.split_once(':') else {
            return Err("recipient must be <chain>:<address>");
        };
        if chain.is_empty() || addr.is_empty() || self.recipient.len() > 128 {
            return Err("recipient must be <chain>:<address>, max 128 chars");
        }
        // One spelling per chain. `NEAR:x` must not count as cross-chain here (skipping the
        // pay_to == address check below) while an oracle reads it as a plain NEAR payment.
        if !chain.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err("chain must be lowercase letters, digits or '-'");
        }
        if self.recipient.contains('|') || self.token.contains('|') {
            return Err("'|' is not allowed in token or recipient");
        }
        if chain == "near" && addr != self.pay_to.as_str() {
            return Err("for near: recipients pay_to must equal the address");
        }
        if self.purpose.len() > 256 {
            return Err("purpose max 256 bytes");
        }
        Ok(())
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    Review,
    Deny,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Allow => "allow",
            Verdict::Review => "review",
            Verdict::Deny => "deny",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Paused,
    TokenNotAllowed,
    ZeroAmount,
    RecipientDenied,
    RecipientNotAllowed,
    RateLimited,
    OverPerTxCap,
    OverPeriodLimit,
    OracleDenied,
    BadAttestation,
    InsufficientBalance,
    PendingQueueFull,
    OracleReview,
    OverApprovalThreshold,
    NeedsAttestation,
    CrossChainNeedsAttestation,
    NewRecipient,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Execute,
    Pending(Reason),
    Deny(Reason),
}

pub struct EvalContext {
    /// Verdict from a valid (signature-checked, unexpired) attestation, if any.
    pub verdict: Option<Verdict>,
    pub known_recipient: bool,
}

/// Decide what happens to a request. `usage` must already be rolled to `now`.
/// Order matters: hard denials first, then reasons to ask a human, then execute.
pub fn evaluate(policy: &Policy, usage: &Usage, req: &SpendRequest, ctx: &EvalContext) -> Decision {
    let Some(limits) = policy.tokens.get(&req.token) else {
        return Decision::Deny(Reason::TokenNotAllowed);
    };
    let amount = req.amount.0;
    if amount == 0 {
        return Decision::Deny(Reason::ZeroAmount);
    }
    let recipient = req.canonical_recipient();
    let pay_to_id = format!("near:{}", req.pay_to);
    if policy
        .denied_recipients
        .iter()
        .map(|d| canonical_recipient(d))
        .any(|d| d == recipient || d == pay_to_id)
    {
        return Decision::Deny(Reason::RecipientDenied);
    }
    if let Some(allowed) = &policy.allowed_recipients {
        if !allowed.iter().any(|a| canonical_recipient(a) == recipient) {
            return Decision::Deny(Reason::RecipientNotAllowed);
        }
    }
    if usage.hour_requests >= policy.max_requests_per_hour {
        return Decision::Deny(Reason::RateLimited);
    }
    if amount > limits.max_per_tx.0 {
        return Decision::Deny(Reason::OverPerTxCap);
    }
    if usage.spent_of(&req.token).saturating_add(amount) > limits.period_limit.0 {
        return Decision::Deny(Reason::OverPeriodLimit);
    }
    match ctx.verdict {
        Some(Verdict::Deny) => return Decision::Deny(Reason::OracleDenied),
        Some(Verdict::Review) => return Decision::Pending(Reason::OracleReview),
        _ => {}
    }
    let attested = ctx.verdict == Some(Verdict::Allow);
    if amount > limits.approval_threshold.0 {
        return Decision::Pending(Reason::OverApprovalThreshold);
    }
    if let Some(t) = limits.attestation_threshold {
        if amount >= t.0 && !attested {
            return Decision::Pending(Reason::NeedsAttestation);
        }
    }
    if req.is_cross_chain() && !attested {
        return Decision::Pending(Reason::CrossChainNeedsAttestation);
    }
    if policy.new_recipient_needs_approval && !ctx.known_recipient {
        return Decision::Pending(Reason::NewRecipient);
    }
    Decision::Execute
}
