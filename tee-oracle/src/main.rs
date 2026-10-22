//! OutLayer entry point: JSON on stdin, JSON on stdout.
//!
//!   {"op": "public_key"}                        -> {"public_key": "<hex>"}
//!   {"op": "verdict", "contract_id", "vault_id", "request", "context"?, "intents_quote"?, "config"?}
//!                                               -> {"verdict", "expires_at", "signature", "score", "signals", "public_key"}
//!
//! The verdict is signed with the `verdicts` key from the manifest: derived inside the TEE
//! for this project and the calling account (`caller: "predecessor"`), never visible to
//! this code, the operator, or anyone else. The module signs only messages it composes
//! itself (`agentguard:v1|…`), never bytes from its input.

use agentguard_tee_oracle::{decide, Host, VerdictInput};
use serde_json::{json, Value};
use std::io::Read;

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

mod signing_keys_host {
    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit-signing" });
}
mod rpc_host {
    wit_bindgen::generate!({ world: "rpc-host", path: "wit-rpc" });
}
use rpc_host::near::rpc::api as rpc;
use signing_keys_host::outlayer::signing_keys::api as keys;

const KEY_PATH: &str = "verdicts";

struct OutLayerHost;

impl Host for OutLayerHost {
    fn now_ms(&self) -> u64 {
        // On chain, the block time the run was requested in; over HTTPS, the TEE's clock.
        if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP").ok().and_then(|v| v.parse::<u64>().ok()) {
            return ns / 1_000_000;
        }
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    fn network_id(&self) -> String {
        std::env::var("NEAR_NETWORK_ID").unwrap_or_default()
    }

    fn vault_owner(&self, contract_id: &str, vault_id: u64) -> Result<String, String> {
        let (result, error) = rpc::view(contract_id, "get_vault", &json!({ "vault_id": vault_id }).to_string(), "final");
        if !error.is_empty() {
            return Err(format!("get_vault failed: {error}"));
        }
        parse_view_result(&result)?["owner"].as_str().map(str::to_string).ok_or_else(|| "vault not found".to_string())
    }
}

/// `view` answers either the function's JSON result, or an RPC result whose `result`
/// field holds the returned bytes. Accept both.
fn parse_view_result(raw: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("bad view result: {e}"))?;
    if let Some(bytes) = v.get("result").and_then(Value::as_array) {
        let bytes: Vec<u8> = bytes.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect();
        return serde_json::from_slice(&bytes).map_err(|e| format!("bad view bytes: {e}"));
    }
    Ok(v)
}

fn public_key() -> Result<String, String> {
    keys::public_key(KEY_PATH, None).map(hex::encode)
}

fn run(input: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| format!("input is not JSON: {e}"))?;
    match v.get("op").and_then(Value::as_str).unwrap_or("verdict") {
        "public_key" => Ok(json!({ "public_key": public_key()? })),
        "verdict" => {
            let input: VerdictInput = serde_json::from_value(v).map_err(|e| format!("bad verdict input: {e}"))?;
            let d = decide(&input, &OutLayerHost);
            let signature = keys::sign(KEY_PATH, None, d.message.as_bytes())?;
            Ok(json!({
                "verdict": d.verdict,
                "expires_at": d.expires_at,
                "signature": hex::encode(signature),
                "score": d.score,
                "signals": d.signals,
                "public_key": public_key()?,
            }))
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let out = run(&input).unwrap_or_else(|e| json!({ "error": e }));
    print!("{out}");
}
