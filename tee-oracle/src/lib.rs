//! AgentGuard risk oracle, built to run as an OutLayer WASI P2 component inside Intel TDX.
//! The decision logic lives here, free of host calls, so it is tested natively; `main.rs`
//! wires it to stdin/stdout, the `near:rpc` view function and the TEE signing key.

pub mod encoding;
pub mod intents;
pub mod rules;

use encoding::{SpendRequest, Verdict};
use rules::{RulesConfig, Signal};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub denylist: Vec<String>,
    pub known_recipients: Vec<String>,
    pub review_at: Option<u32>,
    pub deny_at: Option<u32>,
    pub max_swap_loss_bps: Option<u32>,
    pub ttl_secs: Option<u64>,
    /// Honoured on testnet only: lets a testnet run trust a test 1Click key.
    pub oneclick_manager_pubkey: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerdictInput {
    pub contract_id: String,
    pub vault_id: u64,
    pub request: SpendRequest,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub intents_quote: Option<Value>,
    #[serde(default)]
    pub config: Config,
}

/// What the module needs from its environment.
pub trait Host {
    fn now_ms(&self) -> u64;
    fn network_id(&self) -> String;
    fn vault_owner(&self, contract_id: &str, vault_id: u64) -> Result<String, String>;
}

#[derive(Debug, Serialize)]
pub struct Decision {
    pub verdict: Verdict,
    pub score: u32,
    pub signals: Vec<Signal>,
    /// Nanoseconds, as the contract compares against block time.
    pub expires_at: String,
    /// The exact bytes to sign (see encoding.rs). Not part of the output.
    #[serde(skip)]
    pub message: String,
}

pub fn decide(input: &VerdictInput, host: &dyn Host) -> Decision {
    let c = &input.config;
    let review_at = c.review_at.unwrap_or(35).max(1);
    let deny_at = c.deny_at.unwrap_or(70).max(review_at);
    // A verdict outliving minutes is a replay window; clamp whatever the caller asked.
    let ttl_secs = c.ttl_secs.unwrap_or(120).clamp(30, 600);
    let cfg = RulesConfig {
        denylist: c.denylist.iter().map(|s| s.to_lowercase()).collect(),
        known_recipients: c.known_recipients.clone(),
    };
    let req = &input.request;
    let mut signals = rules::assess(req, &input.context, &cfg);

    let (chain, _) = req.chain_and_address();
    if chain != "near" {
        match &input.intents_quote {
            None => signals.push(Signal::with("cross_chain_binding_unverified", review_at, "no signed 1Click quote")),
            Some(quote) => match host.vault_owner(&input.contract_id, input.vault_id) {
                // Could not check: a human decides, nothing is denied for it.
                Err(e) => signals.push(Signal::with("cross_chain_binding_unverified", review_at, e)),
                Ok(owner) => {
                    let testnet = host.network_id() == "testnet";
                    let manager = c
                        .oneclick_manager_pubkey
                        .as_deref()
                        .filter(|_| testnet)
                        .unwrap_or(intents::ONE_CLICK_MANAGER_PUB_KEY);
                    let problems = intents::verify_binding(
                        req,
                        quote,
                        &intents::BindingOptions {
                            refund_accounts: &[owner],
                            manager_pub_key: manager,
                            max_value_loss_bps: c.max_swap_loss_bps.unwrap_or(300),
                            min_deadline_secs: ttl_secs,
                            now_ms: host.now_ms(),
                        },
                    );
                    if !problems.is_empty() {
                        // A quote that does not match the request is an attack, not a missing proof.
                        signals.push(Signal::with("cross_chain_binding_mismatch", deny_at, problems.join("; ")));
                    }
                }
            },
        }
    }

    let score: u32 = signals.iter().map(|s| s.points).fold(0, u32::saturating_add);
    let verdict = if score >= deny_at {
        Verdict::Deny
    } else if score >= review_at {
        Verdict::Review
    } else {
        Verdict::Allow
    };
    let expires_ns = (host.now_ms() + ttl_secs * 1000) * 1_000_000;
    Decision {
        verdict,
        score,
        signals,
        expires_at: expires_ns.to_string(),
        message: encoding::message(&input.contract_id, input.vault_id, req, verdict, expires_ns),
    }
}

#[cfg(test)]
mod tests;
