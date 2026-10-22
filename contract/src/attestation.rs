//! Risk-oracle verdicts. The oracle runs in a TEE; its ed25519 key is registered per vault
//! by the owner after checking the TEE quote off-chain. On-chain we only check the signature,
//! the expiry, and that the verdict is bound to this exact request (incl. its nonce).

use crate::policy::{SpendRequest, Verdict};
use near_sdk::json_types::U64;
use near_sdk::{env, near, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attestation {
    pub verdict: Verdict,
    /// Block timestamp (ns) after which the verdict is stale.
    pub expires_at: U64,
    /// Hex-encoded 64-byte ed25519 signature over `message(...)`.
    pub signature: String,
}

/// sha256 over a canonical, `|`-separated encoding. `purpose` is hashed first so it may
/// contain any character; `token` and `recipient` are validated to be free of `|`.
pub fn request_hash(req: &SpendRequest) -> [u8; 32] {
    let purpose_hash = hex::encode(env::sha256_array(req.purpose.as_bytes()));
    let canonical = format!(
        "{}|{}|{}|{}|{}|{}",
        req.token, req.amount.0, req.recipient, req.pay_to, purpose_hash, req.nonce
    );
    env::sha256_array(canonical.as_bytes())
}

/// Bytes the oracle signs. Binding the contract id and vault id stops cross-deployment
/// and cross-vault replay; the nonce inside `request_hash` stops same-vault replay.
pub fn message(contract: &AccountId, vault_id: u64, req: &SpendRequest, verdict: Verdict, expires_at: u64) -> String {
    format!(
        "agentguard:v1|{}|{}|{}|{}|{}",
        contract,
        vault_id,
        hex::encode(request_hash(req)),
        verdict.as_str(),
        expires_at
    )
}

/// Returns the verdict if the attestation is valid for this request, else `Err`.
pub fn verify(
    att: &Attestation,
    oracle_pk: &[u8; 32],
    contract: &AccountId,
    vault_id: u64,
    req: &SpendRequest,
    now: u64,
) -> Result<Verdict, &'static str> {
    if now > att.expires_at.0 {
        return Err("attestation expired");
    }
    let sig: [u8; 64] = hex::decode(&att.signature)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("signature must be 64 hex-encoded bytes")?;
    let msg = message(contract, vault_id, req, att.verdict, att.expires_at.0);
    if !env::ed25519_verify(&sig, msg.as_bytes(), oracle_pk) {
        return Err("bad oracle signature");
    }
    Ok(att.verdict)
}

pub fn parse_pk(hex_pk: &str) -> Option<[u8; 32]> {
    hex::decode(hex_pk).ok().and_then(|b| b.try_into().ok())
}
