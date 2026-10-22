//! Port of oracle/src/intents.ts: does a 1Click-signed quote prove that paying `pay_to`
//! delivers to `recipient`, with refunds to the vault owner?
//!
//! `quote_hash` re-implements the official SDK's `quoteHash` (@defuse-protocol/
//! one-click-sdk-typescript 0.1.26): json-stable-stringify of the signed request fields,
//! overlaid with the signed quote fields and the timestamp, sha256, base58. The test
//! vector below was produced by that SDK.

use crate::encoding::SpendRequest;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// 1Click's production manager key, as shipped in the SDK.
pub const ONE_CLICK_MANAGER_PUB_KEY: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

const REQUEST_FIELDS: [&str; 12] = [
    "dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo",
    "refundType", "recipient", "recipientType", "deadline",
];
/// Request fields the SDK signs only when truthy (`x ? x : undefined`).
const REQUEST_FIELDS_IF_SET: [&str; 5] =
    ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"];
const QUOTE_FIELDS: [&str; 8] = [
    "amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd",
    "minAmountOut",
];
/// Extra quote fields of a non-dry quote, signed only when truthy (`x || undefined`).
const FULL_QUOTE_FIELDS_IF_SET: [&str; 7] =
    ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"];

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn quote_hash(resp: &Value) -> String {
    let empty = Map::new();
    let req = resp["quoteRequest"].as_object().unwrap_or(&empty);
    let quote = resp["quote"].as_object().unwrap_or(&empty);
    // serde_json's Map is ordered by key, which is json-stable-stringify's order for ASCII keys.
    let mut signed = Map::new();
    for k in REQUEST_FIELDS {
        if let Some(v) = req.get(k) {
            signed.insert(k.into(), v.clone());
        }
    }
    for k in REQUEST_FIELDS_IF_SET {
        if let Some(v) = req.get(k).filter(|v| truthy(v)) {
            signed.insert(k.into(), v.clone());
        }
    }
    for k in QUOTE_FIELDS {
        if let Some(v) = quote.get(k) {
            signed.insert(k.into(), v.clone());
        }
    }
    if !req.get("dry").is_some_and(truthy) {
        for k in FULL_QUOTE_FIELDS_IF_SET {
            if let Some(v) = quote.get(k).filter(|v| truthy(v)) {
                signed.insert(k.into(), v.clone());
            }
        }
    }
    if let Some(t) = resp.get("timestamp") {
        signed.insert("timestamp".into(), t.clone());
    }
    let json = serde_json::to_string(&Value::Object(signed)).expect("serializable");
    bs58::encode(Sha256::digest(json.as_bytes())).into_string()
}

fn decode_ed25519(v: &str) -> Option<Vec<u8>> {
    bs58::decode(v.strip_prefix("ed25519:").unwrap_or(v)).into_vec().ok()
}

pub fn verify_quote_signature(resp: &Value, manager_pub_key: &str) -> bool {
    let Some(sig) = resp["signature"].as_str().and_then(decode_ed25519) else { return false };
    let Some(pk) = decode_ed25519(manager_pub_key) else { return false };
    let (Ok(sig), Ok(pk)) = (<[u8; 64]>::try_from(sig), <[u8; 32]>::try_from(pk)) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&pk) else { return false };
    key.verify(quote_hash(resp).as_bytes(), &Signature::from_bytes(&sig)).is_ok()
}

/// AgentGuard chain name -> 1Click blockchain name (sdk/src/chains.ts).
pub fn canonical_chain(chain: &str) -> Option<&'static str> {
    Some(match chain.to_lowercase().as_str() {
        "ethereum" | "eth" => "eth",
        "arbitrum" | "arb" => "arb",
        "base" => "base",
        "optimism" | "op" => "op",
        "polygon" | "pol" => "pol",
        "avalanche" | "avax" => "avax",
        "bsc" => "bsc",
        "gnosis" => "gnosis",
        "solana" | "sol" => "sol",
        "bitcoin" | "btc" => "btc",
        "ton" => "ton",
        "tron" => "tron",
        "sui" => "sui",
        "doge" => "doge",
        "xrp" => "xrp",
        "zec" => "zec",
        "bera" => "bera",
        "aptos" => "aptos",
        "cardano" => "cardano",
        "stellar" => "stellar",
        _ => return None,
    })
}

/// Destination chain of `nep141:<chain>[-<token>].omft.near`.
pub fn asset_chain(asset_id: &str) -> Option<&'static str> {
    let rest = asset_id.strip_prefix("nep141:")?.strip_suffix(".omft.near")?;
    let prefix = rest.split('-').next()?;
    if prefix.is_empty() || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) || rest.contains('.') {
        return None;
    }
    canonical_chain(prefix)
}

pub struct BindingOptions<'a> {
    pub refund_accounts: &'a [String],
    pub manager_pub_key: &'a str,
    pub max_value_loss_bps: u32,
    pub min_deadline_secs: u64,
    pub now_ms: u64,
}

fn same_address(a: &str, b: &str) -> bool {
    if a.starts_with("0x") {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn parse_iso_ms(s: &str) -> Option<u64> {
    // YYYY-MM-DDTHH:MM:SS(.fff)?Z — the only shape 1Click returns.
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || !s.ends_with('Z') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let frac = s.get(19..s.len() - 1).unwrap_or("");
    let ms = match frac.strip_prefix('.') {
        Some(f) if !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()) => format!("{f:0<3}")[..3].parse::<i64>().ok()?,
        Some(_) => return None,
        None if frac.is_empty() => 0,
        None => return None,
    };
    // Days from civil (Howard Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from((days * 86_400 + h * 3600 + mi * 60 + se) * 1000 + ms).ok()
}

pub fn verify_binding(req: &SpendRequest, quote: &Value, o: &BindingOptions) -> Vec<String> {
    let mut p = Vec::new();
    let q = &quote["quoteRequest"];
    let r = &quote["quote"];
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let (chain, address) = req.chain_and_address();

    if !verify_quote_signature(quote, o.manager_pub_key) {
        p.push("quote signature is not 1Click's".to_string());
    }
    if q["dry"] != Value::Bool(false) || !truthy(&r["depositAddress"]) {
        p.push("quote is a dry run without a deposit address".into());
    }
    if s(&r["depositAddress"]) != req.pay_to {
        p.push("pay_to is not the quote's deposit address".into());
    }
    if truthy(&r["depositMemo"]) {
        p.push("quote needs a deposit memo, which the vault cannot attach".into());
    }
    if s(&q["depositType"]) != "ORIGIN_CHAIN" {
        p.push("deposit type must be ORIGIN_CHAIN".into());
    }
    if req.token == "near" {
        p.push("native NEAR cannot fund a 1Click deposit; hold wrap.near in the vault".into());
    }
    if s(&q["originAsset"]) != format!("nep141:{}", req.token) {
        p.push(format!("origin asset {} does not match token {}", s(&q["originAsset"]), req.token));
    }
    if s(&q["swapType"]) != "EXACT_INPUT" || s(&q["amount"]) != req.amount || s(&r["amountIn"]) != req.amount {
        p.push("quote must be EXACT_INPUT for exactly the requested amount".into());
    }
    if s(&q["recipientType"]) != "DESTINATION_CHAIN" || !same_address(&s(&q["recipient"]), address) {
        p.push("quote does not deliver to the requested recipient".into());
    }
    let dest = s(&q["destinationAsset"]);
    match (canonical_chain(chain), asset_chain(&dest)) {
        (Some(want), Some(got)) if want == got => {}
        _ => p.push(format!("destination asset {dest} is not on {chain}")),
    }
    if truthy(&q["virtualChainRecipient"]) || truthy(&q["customRecipientMsg"]) {
        p.push("quote redirects delivery (virtual chain or custom message)".into());
    }
    if s(&q["refundType"]) != "ORIGIN_CHAIN" || !o.refund_accounts.contains(&s(&q["refundTo"])) {
        p.push("refunds do not go back to the vault owner".into());
    }
    let deadline = r["deadline"].as_str().or(q["deadline"].as_str()).and_then(parse_iso_ms);
    if !deadline.is_some_and(|d| d > o.now_ms + o.min_deadline_secs * 1000) {
        p.push("quote deadline is too close or passed".into());
    }
    // appFees are not covered by the signature, but the USD values are: cap total value loss.
    let usd = |v: &Value| v.as_str().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
    let (inp, out) = (usd(&r["amountInUsd"]), usd(&r["amountOutUsd"]));
    let max_loss = f64::from(o.max_value_loss_bps) / 10_000.0;
    if !(inp > 0.0 && out >= inp * (1.0 - max_loss)) {
        p.push(format!("swap loses more than {:.1}% of value", max_loss * 100.0));
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-11-05T12:00:00.000Z"), Some(1_793_880_000_000));
        assert_eq!(parse_iso_ms("2026-11-05T12:00:00.5Z"), Some(1_793_880_000_500));
        assert_eq!(parse_iso_ms("2026-11-05 12:00:00Z"), None);
    }

    #[test]
    fn asset_chains() {
        assert_eq!(asset_chain("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"), Some("base"));
        assert_eq!(asset_chain("nep141:eth.omft.near"), Some("eth"));
        assert_eq!(asset_chain("nep141:wrap.near"), None);
    }
}
