use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_700_000_000 * policy::NANOS_PER_SEC;

fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.testnet".parse().unwrap()
}
fn guard() -> AccountId {
    "guard.testnet".parse().unwrap()
}
fn api() -> AccountId {
    "api.testnet".parse().unwrap()
}
fn usdc() -> AccountId {
    "usdc.testnet".parse().unwrap()
}

fn oracle_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn ctx(caller: AccountId, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard())
        .predecessor_account_id(caller.clone())
        .signer_account_id(caller)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn limits(max: u128, period: u128, approval: u128, attest: Option<u128>) -> TokenLimits {
    TokenLimits {
        max_per_tx: U128(max),
        period_limit: U128(period),
        approval_threshold: U128(approval),
        attestation_threshold: attest.map(U128),
    }
}

/// 1 NEAR max per tx, 3 NEAR/day, >0.5 NEAR needs approval, 5 req/hour, new recipients allowed.
fn base_policy() -> Policy {
    let mut tokens = BTreeMap::new();
    tokens.insert(NATIVE.to_string(), limits(ONE_NEAR, 3 * ONE_NEAR, ONE_NEAR / 2, None));
    tokens.insert(usdc().to_string(), limits(5_000_000, 50_000_000, 5_000_000, Some(4_000_000)));
    Policy {
        tokens,
        period_secs: 86_400,
        max_requests_per_hour: 5,
        allowed_recipients: None,
        denied_recipients: vec![],
        new_recipient_needs_approval: false,
        pause_on_rate_limit: true,
    }
}

/// Fresh contract with vault 0 funded with 10 NEAR and an oracle key.
fn setup(policy: Policy) -> Contract {
    ctx(owner(), 0, T0);
    let mut c = Contract::new();
    ctx(owner(), VAULT_STORAGE_FEE.as_yoctonear() + 10 * ONE_NEAR, T0);
    let pk = hex::encode(oracle_key().verifying_key().to_bytes());
    let id = c.create_vault(policy, Some(agent()), Some(pk));
    assert_eq!(id, 0);
    c
}

fn req(c: &Contract, token: &str, amount: u128, recipient: &str, pay_to: &AccountId) -> SpendRequest {
    SpendRequest {
        token: token.to_string(),
        amount: U128(amount),
        recipient: recipient.to_string(),
        pay_to: pay_to.clone(),
        purpose: "buy API credits | test".to_string(),
        nonce: c.get_nonce(0),
    }
}

fn near_req(c: &Contract, amount: u128) -> SpendRequest {
    req(c, NATIVE, amount, "near:api.testnet", &api())
}

fn attest(r: &SpendRequest, verdict: Verdict, expires_at: u64) -> Attestation {
    let msg = attestation::message(&guard(), 0, r, verdict, expires_at);
    Attestation {
        verdict,
        expires_at: U64(expires_at),
        signature: hex::encode(oracle_key().sign(msg.as_bytes()).to_bytes()),
    }
}

fn spend(c: &mut Contract, r: SpendRequest, a: Option<Attestation>) -> SpendResult {
    ctx(agent(), 0, T0 + 1);
    c.request_spend(0, r, a)
}

fn native_balance(c: &Contract) -> u128 {
    c.get_vault(0).unwrap().balance_of(NATIVE)
}

#[test]
fn create_vault_keeps_storage_fee_and_credits_rest() {
    let c = setup(base_policy());
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
    assert_eq!(c.get_vaults_of(owner()), vec![0]);
}

#[test]
fn small_spend_executes_and_debits() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR / 10);
    assert_eq!(spend(&mut c, r, None), SpendResult::Executed { nonce: 0 });
    assert_eq!(native_balance(&c), 10 * ONE_NEAR - ONE_NEAR / 10);
    assert_eq!(c.get_nonce(0), 1);
}

#[test]
#[should_panic(expected = "caller is not this vault's agent")]
fn only_agent_can_request() {
    let mut c = setup(base_policy());
    let r = near_req(&c, 1);
    ctx(api(), 0, T0);
    c.request_spend(0, r, None);
}

#[test]
#[should_panic(expected = "stale or future nonce")]
fn stale_nonce_rejected() {
    let mut c = setup(base_policy());
    let mut r = near_req(&c, 1);
    r.nonce = 5;
    spend(&mut c, r, None);
}

#[test]
fn over_per_tx_cap_denied() {
    let mut c = setup(base_policy());
    let r = near_req(&c, 2 * ONE_NEAR);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::OverPerTxCap });
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
}

#[test]
fn over_approval_threshold_parks_then_owner_approves() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR * 8 / 10);
    assert_eq!(
        spend(&mut c, r, None),
        SpendResult::Pending { pending_id: 0, reason: Reason::OverApprovalThreshold }
    );
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
    ctx(owner(), 1, T0 + 2);
    assert!(c.approve_pending(0, 0));
    assert!(c.get_pending(0).is_empty());
    assert_eq!(native_balance(&c), 10 * ONE_NEAR - ONE_NEAR * 8 / 10);
}

#[test]
fn owner_can_reject_pending() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR * 8 / 10);
    spend(&mut c, r, None);
    ctx(owner(), 1, T0 + 2);
    c.reject_pending(0, 0);
    assert!(c.get_pending(0).is_empty());
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn agent_cannot_approve_its_own_request() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR * 8 / 10);
    spend(&mut c, r, None);
    ctx(agent(), 1, T0 + 2);
    c.approve_pending(0, 0);
}

#[test]
fn new_recipient_needs_approval_once() {
    let mut p = base_policy();
    p.new_recipient_needs_approval = true;
    let mut c = setup(p);
    let r = near_req(&c, ONE_NEAR / 10);
    assert_eq!(spend(&mut c, r, None), SpendResult::Pending { pending_id: 0, reason: Reason::NewRecipient });
    ctx(owner(), 1, T0 + 2);
    c.approve_pending(0, 0);
    let r = near_req(&c, ONE_NEAR / 10);
    assert_eq!(spend(&mut c, r, None), SpendResult::Executed { nonce: 1 });
}

#[test]
fn period_limit_accumulates_and_resets() {
    let mut p = base_policy();
    p.max_requests_per_hour = 100;
    let mut c = setup(p);
    for _ in 0..6 {
        let r = near_req(&c, ONE_NEAR / 2);
        assert!(matches!(spend(&mut c, r, None), SpendResult::Executed { .. }));
    }
    let r = near_req(&c, ONE_NEAR / 2);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::OverPeriodLimit });
    // next day
    let r = near_req(&c, ONE_NEAR / 2);
    ctx(agent(), 0, T0 + 86_401 * policy::NANOS_PER_SEC);
    assert!(matches!(c.request_spend(0, r, None), SpendResult::Executed { .. }));
}

#[test]
fn runaway_loop_trips_rate_limit_and_pauses() {
    let mut c = setup(base_policy());
    for _ in 0..5 {
        let r = near_req(&c, 1);
        assert!(matches!(spend(&mut c, r, None), SpendResult::Executed { .. }));
    }
    let r = near_req(&c, 1);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::RateLimited });
    assert!(c.get_vault(0).unwrap().paused);
    let r = near_req(&c, 1);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::Paused });
}

#[test]
fn kill_switch_blocks_everything_until_unpaused() {
    let mut c = setup(base_policy());
    ctx(owner(), 0, T0);
    c.pause(0);
    let r = near_req(&c, 1);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::Paused });
    ctx(owner(), 1, T0);
    c.unpause(0);
    let r = near_req(&c, 1);
    assert!(matches!(spend(&mut c, r, None), SpendResult::Executed { .. }));
}

#[test]
fn revoked_agent_is_locked_out() {
    let mut c = setup(base_policy());
    ctx(owner(), 1, T0);
    c.set_agent(0, None);
    let r = near_req(&c, 1);
    ctx(agent(), 0, T0);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_spend(0, r, None)));
    assert!(res.is_err());
}

#[test]
fn deny_and_allow_lists() {
    let mut p = base_policy();
    p.denied_recipients = vec!["near:evil.testnet".into()];
    p.allowed_recipients = Some(vec!["near:api.testnet".into(), "near:evil.testnet".into()]);
    let mut c = setup(p);
    let evil: AccountId = "evil.testnet".parse().unwrap();
    let r = req(&c, NATIVE, 1, "near:evil.testnet", &evil);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::RecipientDenied });
    let other: AccountId = "other.testnet".parse().unwrap();
    let r = req(&c, NATIVE, 1, "near:other.testnet", &other);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::RecipientNotAllowed });
    let r = near_req(&c, 1);
    assert!(matches!(spend(&mut c, r, None), SpendResult::Executed { .. }));
}

#[test]
fn denylist_also_matches_pay_to() {
    let mut p = base_policy();
    p.denied_recipients = vec!["near:evil.testnet".into()];
    let mut c = setup(p);
    let evil: AccountId = "evil.testnet".parse().unwrap();
    // A cross-chain recipient that routes through a denied NEAR account is still denied.
    let r = req(&c, NATIVE, 1, "base:0xabc", &evil);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::RecipientDenied });
}

#[test]
fn unknown_token_denied() {
    let mut c = setup(base_policy());
    let r = req(&c, "wbtc.testnet", 1, "near:api.testnet", &api());
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::TokenNotAllowed });
}

#[test]
fn cross_chain_needs_attestation_then_executes_with_valid_one() {
    let mut c = setup(base_policy());
    let deposit_addr: AccountId = "a".repeat(64).parse().unwrap();
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &deposit_addr);
    assert_eq!(
        spend(&mut c, r, None),
        SpendResult::Pending { pending_id: 0, reason: Reason::CrossChainNeedsAttestation }
    );
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &deposit_addr);
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Executed { nonce: 1 });
}

#[test]
fn forged_attestation_denied() {
    let mut c = setup(base_policy());
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &api());
    let mut a = attest(&r, Verdict::Allow, T0 + 1000);
    a.signature = hex::encode(SigningKey::from_bytes(&[9u8; 32]).sign(b"x").to_bytes());
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Denied { reason: Reason::BadAttestation });
}

#[test]
fn attestation_for_other_request_denied() {
    let mut c = setup(base_policy());
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &api());
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    // Agent swaps the beneficiary after getting the verdict.
    let mut swapped = r.clone();
    swapped.recipient = "base:0x2222".into();
    assert_eq!(spend(&mut c, swapped, Some(a)), SpendResult::Denied { reason: Reason::BadAttestation });
}

#[test]
fn attestation_cannot_be_replayed() {
    let mut c = setup(base_policy());
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &api());
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    assert!(matches!(spend(&mut c, r.clone(), Some(a.clone())), SpendResult::Executed { .. }));
    let mut again = r;
    again.nonce = c.get_nonce(0);
    assert_eq!(spend(&mut c, again, Some(a)), SpendResult::Denied { reason: Reason::BadAttestation });
}

#[test]
fn expired_attestation_denied() {
    let mut c = setup(base_policy());
    let r = req(&c, NATIVE, ONE_NEAR / 10, "base:0x1111", &api());
    let a = attest(&r, Verdict::Allow, T0);
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Denied { reason: Reason::BadAttestation });
}

#[test]
fn oracle_deny_and_review_verdicts() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR / 10);
    let a = attest(&r, Verdict::Deny, T0 + 1000);
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Denied { reason: Reason::OracleDenied });
    let r = near_req(&c, ONE_NEAR / 10);
    let a = attest(&r, Verdict::Review, T0 + 1000);
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Pending { pending_id: 0, reason: Reason::OracleReview });
}

#[test]
fn ft_deposit_and_attestation_threshold() {
    let mut c = setup(base_policy());
    ctx(usdc(), 0, T0);
    assert!(matches!(c.ft_on_transfer(owner(), U128(20_000_000), "0".into()), PromiseOrValue::Value(U128(0))));
    assert!(matches!(c.ft_on_transfer(owner(), U128(7), "99".into()), PromiseOrValue::Value(U128(7))));
    assert_eq!(c.get_vault(0).unwrap().balance_of(usdc().as_str()), 20_000_000);
    let r = req(&c, usdc().as_str(), 4_500_000, "near:api.testnet", &api());
    assert_eq!(spend(&mut c, r, None), SpendResult::Pending { pending_id: 0, reason: Reason::NeedsAttestation });
    let r = req(&c, usdc().as_str(), 4_500_000, "near:api.testnet", &api());
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    assert!(matches!(spend(&mut c, r, Some(a)), SpendResult::Executed { .. }));
    assert_eq!(c.get_vault(0).unwrap().balance_of(usdc().as_str()), 15_500_000);
}

#[test]
fn cross_chain_token_spend_pays_registration_from_near_balance() {
    let mut c = setup(base_policy());
    ctx(usdc(), 0, T0);
    let _ = c.ft_on_transfer(owner(), U128(10_000_000), "0".into());
    let deposit_addr: AccountId = "c".repeat(64).parse().unwrap();
    let r = req(&c, usdc().as_str(), 1_000_000, "base:0x1111", &deposit_addr);
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    assert!(matches!(spend(&mut c, r, Some(a)), SpendResult::Executed { .. }));
    let v = c.get_vault(0).unwrap();
    assert_eq!(v.balance_of(usdc().as_str()), 9_000_000);
    assert_eq!(v.balance_of(NATIVE), 10 * ONE_NEAR - FT_STORAGE_REGISTRATION.as_yoctonear());
}

#[test]
fn same_chain_token_spend_pays_no_registration() {
    let mut p = base_policy();
    p.tokens.insert(usdc().to_string(), limits(5_000_000, 50_000_000, 5_000_000, None));
    let mut c = setup(p);
    ctx(usdc(), 0, T0);
    let _ = c.ft_on_transfer(owner(), U128(10_000_000), "0".into());
    let r = req(&c, usdc().as_str(), 1_000_000, "near:api.testnet", &api());
    assert!(matches!(spend(&mut c, r, None), SpendResult::Executed { .. }));
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
}

#[test]
fn cross_chain_token_spend_without_near_for_registration_denied() {
    // Vault with tokens but no NEAR beyond the storage fee.
    ctx(owner(), 0, T0);
    let mut c = Contract::new();
    ctx(owner(), VAULT_STORAGE_FEE.as_yoctonear(), T0);
    let pk = hex::encode(oracle_key().verifying_key().to_bytes());
    c.create_vault(base_policy(), Some(agent()), Some(pk));
    ctx(usdc(), 0, T0);
    let _ = c.ft_on_transfer(owner(), U128(10_000_000), "0".into());
    let deposit_addr: AccountId = "c".repeat(64).parse().unwrap();
    let r = req(&c, usdc().as_str(), 1_000_000, "base:0x1111", &deposit_addr);
    let a = attest(&r, Verdict::Allow, T0 + 1000);
    assert_eq!(spend(&mut c, r, Some(a)), SpendResult::Denied { reason: Reason::InsufficientBalance });
}

#[test]
fn insufficient_balance_denied() {
    let mut p = base_policy();
    p.tokens.insert(usdc().to_string(), limits(5_000_000, 50_000_000, 5_000_000, None));
    let mut c = setup(p);
    let r = req(&c, usdc().as_str(), 1_000_000, "near:api.testnet", &api());
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::InsufficientBalance });
}

#[test]
fn failed_transfer_is_refunded() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR / 10);
    spend(&mut c, r, None);
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard()).predecessor_account_id(guard());
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!c.on_transfer_settled(0, NATIVE.into(), U128(ONE_NEAR / 10), "x".into()));
    assert_eq!(native_balance(&c), 10 * ONE_NEAR);
}

#[test]
fn successful_transfer_is_not_refunded() {
    let mut c = setup(base_policy());
    let r = near_req(&c, ONE_NEAR / 10);
    spend(&mut c, r, None);
    let mut b = VMContextBuilder::new();
    b.current_account_id(guard()).predecessor_account_id(guard());
    testing_env!(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(c.on_transfer_settled(0, NATIVE.into(), U128(ONE_NEAR / 10), "x".into()));
    assert_eq!(native_balance(&c), 10 * ONE_NEAR - ONE_NEAR / 10);
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn only_owner_withdraws() {
    let mut c = setup(base_policy());
    ctx(agent(), 1, T0);
    c.withdraw(0, NATIVE.into(), U128(1), None);
}

#[test]
fn owner_withdraws_while_paused() {
    let mut c = setup(base_policy());
    ctx(owner(), 0, T0);
    c.pause(0);
    ctx(owner(), 1, T0);
    c.withdraw(0, NATIVE.into(), U128(ONE_NEAR), None);
    assert_eq!(native_balance(&c), 9 * ONE_NEAR);
}

#[test]
fn pending_queue_is_bounded() {
    let mut p = base_policy();
    p.max_requests_per_hour = 1000;
    let mut c = setup(p);
    for _ in 0..MAX_PENDING {
        let r = near_req(&c, ONE_NEAR * 8 / 10);
        assert!(matches!(spend(&mut c, r, None), SpendResult::Pending { .. }));
    }
    let r = near_req(&c, ONE_NEAR * 8 / 10);
    assert_eq!(spend(&mut c, r, None), SpendResult::Denied { reason: Reason::PendingQueueFull });
}

/// Same vector is asserted in sdk/test/encoding.test.ts. If one side changes, both fail.
pub const GOLDEN_MESSAGE: &str =
    "agentguard:v1|guard.testnet|0|cb6531a5f332dcfd6262d2cb2b8aa934b496522aa4370c2605da3c24556b1e55|allow|1700000001000000000";

#[test]
fn encoding_matches_typescript_sdk() {
    ctx(owner(), 0, T0);
    let r = SpendRequest {
        token: NATIVE.into(),
        amount: U128(ONE_NEAR / 10),
        recipient: "base:0x1111".into(),
        pay_to: "a".repeat(64).parse().unwrap(),
        purpose: "buy API credits | test".into(),
        nonce: 3,
    };
    assert_eq!(attestation::message(&guard(), 0, &r, Verdict::Allow, 1_700_000_001_000_000_000), GOLDEN_MESSAGE);
}

/// Same key and signature are asserted in oracle/test/signer.test.ts (Node crypto).
#[test]
fn signature_matches_oracle_service() {
    ctx(owner(), 0, T0);
    let key = oracle_key();
    assert_eq!(
        hex::encode(key.verifying_key().to_bytes()),
        "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c"
    );
    let sig = key.sign(GOLDEN_MESSAGE.as_bytes()).to_bytes();
    assert_eq!(
        hex::encode(sig),
        "fce788f15a9e90c8c032c3f0c3b195bc8df75e40264a49a9b55d3ef25af6c76208dcb49a3d0999742f8245cedf54af4de051f5b3ed508c8fd76e7ebd20899a02"
    );
    assert!(env::ed25519_verify(&sig, GOLDEN_MESSAGE.as_bytes(), &key.verifying_key().to_bytes()));
}

#[test]
fn view_message_matches_internal_encoding() {
    let c = setup(base_policy());
    let r = near_req(&c, 5);
    let m = c.attestation_message(0, r.clone(), Verdict::Allow, U64(42));
    assert_eq!(m, attestation::message(&guard(), 0, &r, Verdict::Allow, 42));
    assert!(m.starts_with("agentguard:v1|guard.testnet|0|"));
}
