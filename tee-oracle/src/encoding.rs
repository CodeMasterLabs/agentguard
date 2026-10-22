//! The verdict message. Must match contract/src/attestation.rs byte for byte; the test
//! below checks the same golden vector as the contract and the TypeScript SDK.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SpendRequest {
    pub token: String,
    /// u128 as a decimal string.
    pub amount: String,
    pub recipient: String,
    pub pay_to: String,
    pub purpose: String,
    pub nonce: u64,
}

impl SpendRequest {
    pub fn chain_and_address(&self) -> (&str, &str) {
        self.recipient.split_once(':').unwrap_or(("", ""))
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
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

fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

pub fn request_hash(req: &SpendRequest) -> String {
    sha256_hex(&format!(
        "{}|{}|{}|{}|{}|{}",
        req.token,
        req.amount,
        req.recipient,
        req.pay_to,
        sha256_hex(&req.purpose),
        req.nonce
    ))
}

pub fn message(contract: &str, vault_id: u64, req: &SpendRequest, verdict: Verdict, expires_at: u64) -> String {
    format!("agentguard:v1|{contract}|{vault_id}|{}|{}|{expires_at}", request_hash(req), verdict.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_contract_golden_vector() {
        let r = SpendRequest {
            token: "near".into(),
            amount: "100000000000000000000000".into(),
            recipient: "base:0x1111".into(),
            pay_to: "a".repeat(64),
            purpose: "buy API credits | test".into(),
            nonce: 3,
        };
        assert_eq!(
            message("guard.testnet", 0, &r, Verdict::Allow, 1_700_000_001_000_000_000),
            "agentguard:v1|guard.testnet|0|cb6531a5f332dcfd6262d2cb2b8aa934b496522aa4370c2605da3c24556b1e55|allow|1700000001000000000"
        );
    }
}
