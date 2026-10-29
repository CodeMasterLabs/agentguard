//! AgentGuard: a spending firewall for AI agents.
//!
//! An owner (a person, a Sputnik DAO or a Trezu multisig) funds a vault and writes a policy.
//! The agent's NEAR account holds only a function-call key for `request_spend`, so the agent
//! can ask to spend but never move funds directly. Each request is executed, parked for the
//! owner's approval, or denied, and every outcome is logged as a NEP-297 event.

mod attestation;
mod policy;

pub use attestation::Attestation;
pub use policy::{Decision, Policy, Reason, SpendRequest, TokenLimits, Usage, Verdict, NATIVE};

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::BTreeMap;

pub type VaultId = u64;

pub const MAX_PENDING: usize = 32;
/// Policy size caps: they bound a vault's storage and the gas of every call that loads it.
pub const MAX_POLICY_TOKENS: usize = 16;
pub const MAX_POLICY_LIST: usize = 64;
const MAX_RECIPIENT_LEN: usize = 128;
/// NEP-145 registration for a fresh receiver (wrap.near and most tokens ask 0.00125 NEAR).
/// Paid from the vault's NEAR balance before a cross-chain token payment, because NEAR
/// Intents deposit addresses are new accounts the token contract has never seen.
pub const FT_STORAGE_REGISTRATION: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// The callback loads and stores the vault; it also gets a share of any unused gas.
const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(15);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

/// Cross-chain token payments go to a NEAR Intents deposit address that needs registering
/// with the token first.
fn needs_registration(req: &SpendRequest) -> bool {
    req.token != NATIVE && req.is_cross_chain()
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSpend {
    pub id: u64,
    pub request: SpendRequest,
    pub reason: Reason,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Vault {
    pub owner: AccountId,
    pub agent: Option<AccountId>,
    /// Hex ed25519 public key of the risk oracle trusted by this vault.
    pub oracle_pk: Option<String>,
    pub policy: Policy,
    pub usage: Usage,
    pub balances: BTreeMap<String, U128>,
    pub paused: bool,
    pub nonce: u64,
    pub pending: Vec<PendingSpend>,
    pub next_pending_id: u64,
}

impl Vault {
    fn balance_of(&self, token: &str) -> u128 {
        self.balances.get(token).map(|b| b.0).unwrap_or(0)
    }

    fn credit(&mut self, token: &str, amount: u128) {
        let b = self.balance_of(token).checked_add(amount).expect("balance overflow");
        self.balances.insert(token.to_string(), U128(b));
    }

    /// Token amount, plus the registration fee in NEAR when the payment needs one.
    fn can_cover(&self, req: &SpendRequest) -> bool {
        let fee = if needs_registration(req) { FT_STORAGE_REGISTRATION.as_yoctonear() } else { 0 };
        self.balance_of(&req.token) >= req.amount.0 && self.balance_of(NATIVE) >= fee
    }

    fn debit(&mut self, token: &str, amount: u128) -> bool {
        let b = self.balance_of(token);
        if b < amount {
            return false;
        }
        self.balances.insert(token.to_string(), U128(b - amount));
        true
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SpendResult {
    Executed { nonce: u64 },
    Pending { pending_id: u64, reason: Reason },
    Denied { reason: Reason },
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vaults,
    OwnerIndex,
    KnownRecipients,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    vaults: LookupMap<VaultId, Vault>,
    owner_index: LookupMap<AccountId, Vec<VaultId>>,
    /// `"{vault_id}:{recipient}"` for every recipient a vault has paid.
    known_recipients: LookupSet<String>,
    next_vault_id: VaultId,
}

fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "agentguard", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn validate_policy(p: &Policy) {
    require!(p.period_secs > 0, "period_secs must be > 0");
    require!(p.max_requests_per_hour > 0, "max_requests_per_hour must be > 0");
    require!(p.tokens.len() <= MAX_POLICY_TOKENS, "too many tokens in policy");
    let lists = [p.allowed_recipients.as_deref().unwrap_or(&[]), &p.denied_recipients[..]];
    for list in lists {
        require!(list.len() <= MAX_POLICY_LIST, "recipient list too long");
        require!(list.iter().all(|r| r.len() <= MAX_RECIPIENT_LEN), "recipient too long");
    }
    for (token, l) in &p.tokens {
        require!(
            token == NATIVE || token.parse::<AccountId>().is_ok(),
            "token must be \"near\" or a NEP-141 account id"
        );
        require!(l.max_per_tx.0 <= l.period_limit.0, "max_per_tx must be <= period_limit");
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            vaults: LookupMap::new(StorageKey::Vaults),
            owner_index: LookupMap::new(StorageKey::OwnerIndex),
            known_recipients: LookupSet::new(StorageKey::KnownRecipients),
            next_vault_id: 0,
        }
    }

    // ---------- owner ----------

    /// Create a vault owned by the caller. The attached NEAR first pays for the vault's
    /// storage (measured, a few milliNEAR); the rest becomes the vault's NEAR balance.
    #[payable]
    pub fn create_vault(&mut self, policy: Policy, agent: Option<AccountId>, oracle_pk: Option<String>) -> VaultId {
        let before = env::storage_usage();
        let deposit = env::attached_deposit().as_yoctonear();
        validate_policy(&policy);
        if let Some(pk) = &oracle_pk {
            require!(attestation::parse_pk(pk).is_some(), "oracle_pk must be 32 hex-encoded bytes");
        }
        let owner = env::predecessor_account_id();
        let id = self.next_vault_id;
        self.next_vault_id += 1;
        let vault = Vault {
            owner: owner.clone(),
            agent,
            oracle_pk,
            policy,
            usage: Usage { period_start: U64(env::block_timestamp()), hour_start: U64(env::block_timestamp()), ..Default::default() },
            // The NEAR entry always exists, so later storage charges never change its size.
            balances: BTreeMap::from([(NATIVE.to_string(), U128(0))]),
            paused: false,
            nonce: 0,
            pending: Vec::new(),
            next_pending_id: 0,
        };
        emit("vault_created", json!({ "vault_id": id, "owner": owner, "agent": vault.agent }));
        self.vaults.insert(id, vault);
        self.owner_index.entry(owner).or_default().push(id);
        let cost = self.storage_cost_since(before);
        require!(deposit >= cost, format!("attach at least {cost} yoctoNEAR for the vault's storage"));
        self.vaults.get_mut(&id).unwrap().credit(NATIVE, deposit - cost);
        id
    }

    #[payable]
    pub fn update_policy(&mut self, vault_id: VaultId, policy: Policy) {
        near_sdk::assert_one_yocto();
        let before = env::storage_usage();
        validate_policy(&policy);
        let vault = self.owned_vault_mut(vault_id);
        vault.policy = policy;
        emit("policy_updated", json!({ "vault_id": vault_id }));
        self.settle_storage(vault_id, before);
    }

    /// Set or revoke (`None`) the agent account allowed to request spends.
    #[payable]
    pub fn set_agent(&mut self, vault_id: VaultId, agent: Option<AccountId>) {
        near_sdk::assert_one_yocto();
        let before = env::storage_usage();
        let vault = self.owned_vault_mut(vault_id);
        vault.agent = agent.clone();
        emit("agent_set", json!({ "vault_id": vault_id, "agent": agent }));
        self.settle_storage(vault_id, before);
    }

    #[payable]
    pub fn set_oracle(&mut self, vault_id: VaultId, oracle_pk: Option<String>) {
        near_sdk::assert_one_yocto();
        if let Some(pk) = &oracle_pk {
            require!(attestation::parse_pk(pk).is_some(), "oracle_pk must be 32 hex-encoded bytes");
        }
        let before = env::storage_usage();
        let vault = self.owned_vault_mut(vault_id);
        vault.oracle_pk = oracle_pk;
        emit("oracle_set", json!({ "vault_id": vault_id }));
        self.settle_storage(vault_id, before);
    }

    /// Kill switch. Deliberately needs no deposit so it works from any key, fast.
    pub fn pause(&mut self, vault_id: VaultId) {
        let vault = self.owned_vault_mut(vault_id);
        vault.paused = true;
        emit("vault_paused", json!({ "vault_id": vault_id, "by": "owner" }));
    }

    #[payable]
    pub fn unpause(&mut self, vault_id: VaultId) {
        near_sdk::assert_one_yocto();
        let vault = self.owned_vault_mut(vault_id);
        vault.paused = false;
        vault.usage.hour_requests = 0;
        emit("vault_unpaused", json!({ "vault_id": vault_id }));
    }

    /// Approve a parked spend. A human approval overrides the policy limits, but not the
    /// balance, and the spend still counts toward the period usage.
    #[payable]
    pub fn approve_pending(&mut self, vault_id: VaultId, pending_id: u64) -> bool {
        near_sdk::assert_one_yocto();
        let before = env::storage_usage();
        let vault = self.owned_vault_mut(vault_id);
        let idx = vault.pending.iter().position(|p| p.id == pending_id).expect("no such pending spend");
        let req = vault.pending[idx].request.clone();
        require!(vault.can_cover(&req), "insufficient vault balance");
        vault.pending.remove(idx);
        emit("pending_approved", json!({ "vault_id": vault_id, "pending_id": pending_id }));
        self.execute(vault_id, &req);
        self.settle_storage(vault_id, before);
        true
    }

    #[payable]
    pub fn reject_pending(&mut self, vault_id: VaultId, pending_id: u64) {
        near_sdk::assert_one_yocto();
        let before = env::storage_usage();
        let vault = self.owned_vault_mut(vault_id);
        let count = vault.pending.len();
        vault.pending.retain(|p| p.id != pending_id);
        require!(vault.pending.len() < count, "no such pending spend");
        emit("pending_rejected", json!({ "vault_id": vault_id, "pending_id": pending_id }));
        self.settle_storage(vault_id, before);
    }

    /// Owner withdrawal. Works while paused.
    #[payable]
    pub fn withdraw(&mut self, vault_id: VaultId, token: String, amount: U128, to: Option<AccountId>) {
        near_sdk::assert_one_yocto();
        // A zero debit of an unknown token would add a balance entry (storage) for free.
        require!(amount.0 > 0, "amount must be > 0");
        let before = env::storage_usage();
        let vault = self.owned_vault_mut(vault_id);
        let to = to.unwrap_or_else(|| vault.owner.clone());
        require!(vault.debit(&token, amount.0), "insufficient vault balance");
        emit("withdrawn", json!({ "vault_id": vault_id, "token": token, "amount": amount, "to": to }));
        self.settle_storage(vault_id, before);
        self.transfer_out(vault_id, &token, amount.0, &to, "agentguard withdraw".to_string(), false);
    }

    // ---------- funding ----------

    #[payable]
    pub fn deposit_near(&mut self, vault_id: VaultId) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let before = env::storage_usage();
        let vault = self.vaults.get_mut(&vault_id).expect("no such vault");
        vault.credit(NATIVE, amount);
        emit("deposited", json!({ "vault_id": vault_id, "token": NATIVE, "amount": U128(amount) }));
        self.settle_storage(vault_id, before);
    }

    /// NEP-141 receiver. `msg` is the vault id. Tokens go back to the sender when the vault
    /// does not exist, the token is not in its policy (so no one can bloat a vault with junk
    /// tokens), or the vault cannot pay for a new balance entry (the panic makes the token
    /// contract refund).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id().to_string();
        let before = env::storage_usage();
        let Some((vault_id, vault)) = msg.trim().parse::<VaultId>().ok().and_then(|id| self.vaults.get_mut(&id).map(|v| (id, v))) else {
            return PromiseOrValue::Value(amount);
        };
        if !vault.policy.tokens.contains_key(&token) {
            return PromiseOrValue::Value(amount);
        }
        vault.credit(&token, amount.0);
        emit("deposited", json!({ "vault_id": vault_id, "token": token, "amount": amount, "from": sender_id }));
        self.settle_storage(vault_id, before);
        PromiseOrValue::Value(U128(0))
    }

    // ---------- agent ----------

    /// The only method the agent's function-call key can call. Never panics on a policy
    /// failure: denials are returned (and logged) so usage and pauses are persisted.
    pub fn request_spend(&mut self, vault_id: VaultId, request: SpendRequest, attestation: Option<Attestation>) -> SpendResult {
        if let Err(e) = request.validate() {
            env::panic_str(e);
        }
        let before = env::storage_usage();
        let now = env::block_timestamp();
        let contract_id = env::current_account_id();
        let known = self.known_recipients.contains(&format!("{vault_id}:{}", request.canonical_recipient()));
        let vault = self.vaults.get_mut(&vault_id).expect("no such vault");
        require!(
            vault.agent.as_ref() == Some(&env::predecessor_account_id()),
            "caller is not this vault's agent"
        );
        require!(request.nonce == vault.nonce, "stale or future nonce");
        vault.nonce += 1;
        vault.usage.roll(now, vault.policy.period_secs);

        let decision = if vault.paused {
            Decision::Deny(Reason::Paused)
        } else {
            let verdict = match (&attestation, vault.oracle_pk.as_deref().and_then(attestation::parse_pk)) {
                (None, _) => Ok(None),
                (Some(_), None) => Err(()),
                (Some(att), Some(pk)) => attestation::verify(att, &pk, &contract_id, vault_id, &request, now)
                    .map(Some)
                    .map_err(|_| ()),
            };
            match verdict {
                Err(()) => Decision::Deny(Reason::BadAttestation),
                Ok(verdict) => {
                    let ctx = policy::EvalContext { verdict, known_recipient: known };
                    policy::evaluate(&vault.policy, &vault.usage, &request, &ctx)
                }
            }
        };
        vault.usage.hour_requests = vault.usage.hour_requests.saturating_add(1);

        let decision = match decision {
            Decision::Execute if !vault.can_cover(&request) => {
                Decision::Deny(Reason::InsufficientBalance)
            }
            Decision::Pending(_) if vault.pending.len() >= MAX_PENDING => Decision::Deny(Reason::PendingQueueFull),
            d => d,
        };

        let base = json!({
            "vault_id": vault_id, "nonce": request.nonce, "token": request.token, "amount": request.amount,
            "recipient": request.recipient, "pay_to": request.pay_to, "purpose": request.purpose,
        });
        let result = match decision {
            Decision::Execute => {
                self.execute(vault_id, &request);
                SpendResult::Executed { nonce: request.nonce }
            }
            Decision::Pending(reason) => {
                let id = vault.next_pending_id;
                vault.next_pending_id += 1;
                vault.pending.push(PendingSpend { id, request, reason, created_at: U64(now) });
                emit("spend_pending", json!({ "request": base, "pending_id": id, "reason": reason }));
                SpendResult::Pending { pending_id: id, reason }
            }
            Decision::Deny(reason) => {
                if reason == Reason::RateLimited && vault.policy.pause_on_rate_limit && !vault.paused {
                    vault.paused = true;
                    emit("vault_paused", json!({ "vault_id": vault_id, "by": "rate_limit" }));
                }
                emit("spend_denied", json!({ "request": base, "reason": reason }));
                SpendResult::Denied { reason }
            }
        };
        // Parked spends and newly known recipients are paid for by this vault.
        self.settle_storage(vault_id, before);
        result
    }

    // ---------- callbacks ----------

    /// Re-credits the vault if the outgoing transfer failed (e.g. receiver not registered
    /// with the token, or a non-existent account).
    #[private]
    pub fn on_transfer_settled(&mut self, vault_id: VaultId, token: String, amount: U128, ref_id: String) -> bool {
        // Neither a native transfer nor ft_transfer returns data, so cap the read at 0 bytes.
        let ok = env::promise_result_checked(0, 0).is_ok();
        if !ok {
            if let Some(vault) = self.vaults.get_mut(&vault_id) {
                vault.credit(&token, amount.0);
            }
        }
        emit(
            if ok { "transfer_settled" } else { "transfer_failed_refunded" },
            json!({ "vault_id": vault_id, "token": token, "amount": amount, "ref": ref_id }),
        );
        ok
    }

    // ---------- views ----------

    pub fn get_vault(&self, vault_id: VaultId) -> Option<&Vault> {
        self.vaults.get(&vault_id)
    }

    pub fn get_nonce(&self, vault_id: VaultId) -> u64 {
        self.vaults.get(&vault_id).expect("no such vault").nonce
    }

    pub fn get_pending(&self, vault_id: VaultId) -> Vec<PendingSpend> {
        self.vaults.get(&vault_id).map(|v| v.pending.clone()).unwrap_or_default()
    }

    pub fn get_vaults_of(&self, owner: AccountId) -> Vec<VaultId> {
        self.owner_index.get(&owner).cloned().unwrap_or_default()
    }

    /// The exact string an oracle must sign for this request. Lets off-chain code check
    /// its encoding against the contract instead of re-implementing it blindly.
    pub fn attestation_message(&self, vault_id: VaultId, request: SpendRequest, verdict: Verdict, expires_at: U64) -> String {
        attestation::message(&env::current_account_id(), vault_id, &request, verdict, expires_at.0)
    }
}

impl Contract {
    /// Write pending collection changes and price the storage added since `before`
    /// (0 if storage shrank). The maps buffer writes, so they are flushed first (LookupSet writes at once).
    fn storage_cost_since(&mut self, before: u64) -> u128 {
        self.vaults.flush();
        self.owner_index.flush();
        u128::from(env::storage_usage().saturating_sub(before)) * env::storage_byte_cost().as_yoctonear()
    }

    /// Every vault pays for its own storage out of its NEAR balance, and gets it back when
    /// storage is freed. Without this, one vault could lock NEAR that other vaults own
    /// (the contract's balance backs its storage). Panics, reverting the call, if the vault
    /// cannot pay.
    fn settle_storage(&mut self, vault_id: VaultId, before: u64) {
        let cost = self.storage_cost_since(before);
        let freed = u128::from(before.saturating_sub(env::storage_usage())) * env::storage_byte_cost().as_yoctonear();
        let vault = self.vaults.get_mut(&vault_id).expect("no such vault");
        if cost > 0 {
            require!(vault.debit(NATIVE, cost), "the vault needs more NEAR to pay for its storage");
        } else if freed > 0 {
            vault.credit(NATIVE, freed);
        }
    }

    fn owned_vault_mut(&mut self, vault_id: VaultId) -> &mut Vault {
        let vault = self.vaults.get_mut(&vault_id).expect("no such vault");
        require!(vault.owner == env::predecessor_account_id(), "only the vault owner");
        vault
    }

    /// Debit, record usage, remember the recipient, and send the funds.
    fn execute(&mut self, vault_id: VaultId, req: &SpendRequest) {
        let vault = self.vaults.get_mut(&vault_id).expect("no such vault");
        let register = needs_registration(req);
        require!(vault.can_cover(req), "insufficient vault balance");
        vault.debit(&req.token, req.amount.0);
        if register {
            vault.debit(NATIVE, FT_STORAGE_REGISTRATION.as_yoctonear());
        }
        vault.usage.add_spent(&req.token, req.amount.0);
        self.known_recipients.insert(format!("{vault_id}:{}", req.canonical_recipient()));
        emit(
            "spend_executed",
            json!({
                "vault_id": vault_id, "nonce": req.nonce, "token": req.token, "amount": req.amount,
                "recipient": req.recipient, "pay_to": req.pay_to, "purpose": req.purpose,
            }),
        );
        let memo = format!("agentguard:{vault_id}:{}", req.nonce);
        self.transfer_out(vault_id, &req.token, req.amount.0, &req.pay_to, memo, register);
    }

    /// With `register`, first pays the receiver's NEP-145 storage on the token. If the
    /// receiver is already registered the token refunds that deposit to this contract.
    /// The settle callback sees the result of the transfer itself.
    fn transfer_out(&self, vault_id: VaultId, token: &str, amount: u128, to: &AccountId, memo: String, register: bool) {
        let send = if token == NATIVE {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount))
        } else {
            let token_id: AccountId = token.parse().expect("bad token id");
            let transfer = ext_ft::ext(token_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(to.clone(), U128(amount), Some(memo.clone()));
            if register {
                ext_ft::ext(token_id)
                    .with_attached_deposit(FT_STORAGE_REGISTRATION)
                    .with_static_gas(GAS_STORAGE_DEPOSIT)
                    .storage_deposit(Some(to.clone()), Some(true))
                    .then(transfer)
            } else {
                transfer
            }
        };
        send.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_SETTLE_CALLBACK)
                .on_transfer_settled(vault_id, token.to_string(), U128(amount), memo),
        )
        .detach();
    }
}

#[cfg(test)]
mod tests;
