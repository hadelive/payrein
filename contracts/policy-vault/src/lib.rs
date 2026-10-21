//! Policy vault: pays allowlisted merchants from its own NEAR Intents balance on an agent's
//! request, within limits this contract enforces. Behaviour is specified in
//! `docs/payment-spec.md`; threat ids (T1..T26) refer to `docs/threat-model.md`.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

#[cfg(test)]
mod tests;

pub const MAX_ACTIVE: usize = 16;
pub const RECENT: u64 = 64;
pub const MAX_MERCHANTS: usize = 32;
pub const MAX_LABEL_LEN: usize = 32;
pub const MAX_INVOICE_REF_LEN: usize = 64;
pub const MAX_TOKEN_ID_LEN: usize = 128;
pub const NS_PER_SEC: u64 = 1_000_000_000;
pub const NS_PER_DAY: u64 = 86_400 * NS_PER_SEC;
pub const STUCK_AFTER_NS: u64 = 600 * NS_PER_SEC;

pub const GAS_MT_TRANSFER: Gas = Gas::from_tgas(15);
#[cfg(not(feature = "test-gas"))]
pub const GAS_ON_SETTLED: Gas = Gas::from_tgas(10);
// Too little to run the callback at all: t17b uses it to leave a transfer settled but unrecorded.
#[cfg(feature = "test-gas")]
pub const GAS_ON_SETTLED: Gas = Gas::from_ggas(300);
/// What `request_payment` and `approve` still need after the gas check, before the promises.
pub const GAS_SELF: Gas = Gas::from_tgas(15);

#[ext_contract(ext_mt)]
#[allow(dead_code)]
trait MultiToken {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultError {
    Paused,
    NotAgent,
    NotOwner,
    InsufficientGas,
    PolicyVersionMismatch,
    Expired,
    TtlTooLong,
    MerchantNotAllowed,
    WrongToken,
    ZeroAmount,
    InvoiceRefTooLong,
    OverPerPayment,
    TooManyPending,
    OverDaily,
    NotAwaitingApproval,
    ApprovalMismatch,
    NotDispatched,
    NotStuckYet,
    InvalidPolicy,
    TooManyMerchants,
    InvalidMerchant,
    UnknownMerchant,
}

fn fail(e: VaultError) -> ! {
    env::panic_str(&format!("{e:?}"))
}

/// Owner-set limits. `version` and `paused` are managed by the contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub version: u32,
    pub token_id: String,
    pub per_payment_max: U128,
    pub daily_max: U128,
    pub approval_threshold: U128,
    pub max_ttl_sec: u32,
    pub max_pending: u16,
    pub paused: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PolicyInput {
    pub token_id: String,
    pub per_payment_max: U128,
    pub daily_max: U128,
    pub approval_threshold: U128,
    pub max_ttl_sec: u32,
    pub max_pending: u16,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Merchant {
    pub account_id: AccountId,
    pub label: String,
}

/// What the agent submits.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRequest {
    pub merchant_id: AccountId,
    pub token_id: String,
    pub amount: U128,
    pub invoice_ref: String,
    pub expires_at_ns: U64,
    pub policy_version: u32,
}

/// A request with the id the vault assigned. `approve` takes this whole value back, so the
/// owner's wallet shows every field it binds.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOp {
    pub op_id: U64,
    #[serde(flatten)]
    pub req: PaymentRequest,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpStatus {
    AwaitingApproval,
    Dispatched,
    Settled,
    Failed,
    Rejected,
    Released,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StuckOutcome {
    Settled,
    Released,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpRecord {
    pub op: PaymentOp,
    pub status: OpStatus,
    /// UTC day of dispatch; set when the op is dispatched.
    pub day: Option<U64>,
    pub created_ns: U64,
    pub dispatched_ns: Option<U64>,
    pub finished_ns: Option<U64>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub intents: AccountId,
    pub policy: Policy,
    pub next_op_id: U64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct Budget {
    pub day: U64,
    pub daily_max: U128,
    pub spent: U128,
    pub reserved: U128,
    pub remaining: U128,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    NeedsApproval,
    Reject,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct CheckResult {
    pub decision: Decision,
    pub code: Option<VaultError>,
    pub remaining_after: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    intents: AccountId,
    policy: Policy,
    merchants: Vec<Merchant>,
    next_op_id: u64,
    /// AwaitingApproval and Dispatched ops; at most MAX_ACTIVE.
    active: Vec<OpRecord>,
    /// Finished ops in a fixed ring of RECENT slots, keyed by `finished_seq % RECENT`.
    recent: LookupMap<u64, OpRecord>,
    finished_seq: u64,
    /// (UTC day, settled spend on that day).
    today: (u64, u128),
}

#[near]
impl Vault {
    /// Deployed in the same transaction that creates the account (no access key ever exists),
    /// so nobody can initialise it first (T23). `#[init]` refuses a second call.
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        intents: AccountId,
        policy: PolicyInput,
        merchants: Vec<Merchant>,
    ) -> Self {
        if merchants.len() > MAX_MERCHANTS {
            fail(VaultError::TooManyMerchants);
        }
        for (i, m) in merchants.iter().enumerate() {
            if m.label.len() > MAX_LABEL_LEN
                || merchants[..i].iter().any(|o| o.account_id == m.account_id)
            {
                fail(VaultError::InvalidMerchant);
            }
        }
        Self {
            owner,
            agent,
            intents,
            policy: validated_policy(policy, 1, false),
            merchants,
            next_op_id: 1,
            active: Vec::new(),
            recent: LookupMap::new(b"r".to_vec()),
            finished_seq: 0,
            today: (0, 0),
        }
    }

    // ---- Agent ----

    /// Admits a payment: dispatches it now, or holds it for owner approval when it is above the
    /// threshold. Every rejection panics, so nothing is stored for it.
    pub fn request_payment(&mut self, req: PaymentRequest) -> PaymentOp {
        let now = env::block_timestamp();
        if self.policy.paused {
            fail(VaultError::Paused);
        }
        if env::predecessor_account_id() != self.agent {
            fail(VaultError::NotAgent);
        }
        require_dispatch_gas();
        let dispatch_now = req.amount.0 <= self.policy.approval_threshold.0;
        if let Err(e) = self.check_request(&req, now, true, true, dispatch_now) {
            fail(e);
        }
        self.cleanup_expired(now);

        let op = PaymentOp { op_id: U64(self.next_op_id), req };
        self.next_op_id += 1;
        self.active.push(OpRecord {
            op: op.clone(),
            status: OpStatus::AwaitingApproval,
            day: None,
            created_ns: U64(now),
            dispatched_ns: None,
            finished_ns: None,
        });
        emit("requested", json!({ "op": op }));
        if dispatch_now {
            self.dispatch(op.op_id.0, now).detach();
        } else {
            emit("awaiting_approval", json!({ "op_id": op.op_id }));
        }
        op
    }

    // ---- Owner ----

    /// Dispatches an awaiting op. `op` must equal the stored op in every field (T9), and the
    /// limits are checked again (T12). Approval lifts only the threshold.
    #[payable]
    pub fn approve(&mut self, op: PaymentOp) {
        assert_one_yocto();
        self.require_owner();
        let now = env::block_timestamp();
        let Some(stored) = self.awaiting(op.op_id.0) else {
            fail(VaultError::NotAwaitingApproval);
        };
        if stored.op != op {
            fail(VaultError::ApprovalMismatch);
        }
        if self.policy.paused {
            fail(VaultError::Paused);
        }
        require_dispatch_gas();
        if let Err(e) = self.check_request(&op.req, now, false, false, true) {
            fail(e);
        }
        self.cleanup_expired(now);
        emit("approved", json!({ "op_id": op.op_id }));
        self.dispatch(op.op_id.0, now).detach();
    }

    #[payable]
    pub fn reject(&mut self, op_id: U64) {
        assert_one_yocto();
        self.require_owner();
        if self.awaiting(op_id.0).is_none() {
            fail(VaultError::NotAwaitingApproval);
        }
        self.reject_where(env::block_timestamp(), "owner", |r| r.op.op_id == op_id);
    }

    #[payable]
    pub fn set_policy(&mut self, policy: PolicyInput) {
        assert_one_yocto();
        self.require_owner();
        self.policy = validated_policy(policy, self.policy.version, self.policy.paused);
        self.policy_changed("set_policy");
    }

    #[payable]
    pub fn add_merchant(&mut self, merchant: Merchant) {
        assert_one_yocto();
        self.require_owner();
        if self.merchants.len() >= MAX_MERCHANTS {
            fail(VaultError::TooManyMerchants);
        }
        if merchant.label.len() > MAX_LABEL_LEN
            || self.merchants.iter().any(|m| m.account_id == merchant.account_id)
        {
            fail(VaultError::InvalidMerchant);
        }
        self.merchants.push(merchant);
        self.policy_changed("add_merchant");
    }

    #[payable]
    pub fn remove_merchant(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.require_owner();
        let Some(i) = self.merchants.iter().position(|m| m.account_id == account_id) else {
            fail(VaultError::UnknownMerchant);
        };
        self.merchants.remove(i);
        self.policy_changed("remove_merchant");
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        assert_one_yocto();
        self.require_owner();
        self.agent = agent;
        self.policy_changed("set_agent");
    }

    #[payable]
    pub fn pause(&mut self) {
        assert_one_yocto();
        self.require_owner();
        self.policy.paused = true;
        self.policy_changed("pause");
    }

    #[payable]
    pub fn unpause(&mut self) {
        assert_one_yocto();
        self.require_owner();
        self.policy.paused = false;
        self.policy_changed("unpause");
    }

    /// Moves funds to the owner. It ignores reservations: a dispatched payment that then lacks
    /// balance fails and its callback releases the budget (T16).
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        self.require_owner();
        if amount.0 == 0 {
            fail(VaultError::ZeroAmount);
        }
        emit("withdraw", json!({ "amount": amount }));
        ext_mt::ext(self.intents.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_MT_TRANSFER)
            .mt_transfer(
                self.owner.clone(),
                self.policy.token_id.clone(),
                amount,
                None,
                Some("vault:withdraw".to_string()),
            )
    }

    /// Ends an op whose callback never ran. `Released` returns the budget on the owner's word
    /// that the transfer failed; the contract cannot verify that.
    #[payable]
    pub fn release_stuck(&mut self, op_id: U64, outcome: StuckOutcome) {
        assert_one_yocto();
        self.require_owner();
        let now = env::block_timestamp();
        let Some(rec) = self
            .active
            .iter()
            .find(|r| r.op.op_id == op_id && r.status == OpStatus::Dispatched)
        else {
            fail(VaultError::NotDispatched);
        };
        let dispatched = rec.dispatched_ns.map_or(now, |t| t.0);
        if now.saturating_sub(dispatched) < STUCK_AFTER_NS {
            fail(VaultError::NotStuckYet);
        }
        let outcome = match outcome {
            StuckOutcome::Settled => OpStatus::Settled,
            StuckOutcome::Released => OpStatus::Released,
        };
        self.finish(op_id.0, outcome, now, "owner");
    }

    // ---- Anyone ----

    /// Rejects awaiting ops past their expiry. Admission already ignores them, so this only
    /// tidies state; every committing method runs it too.
    pub fn cleanup(&mut self) {
        self.cleanup_expired(env::block_timestamp());
    }

    // ---- Callback ----

    #[private]
    pub fn on_settled(&mut self, op_id: U64) {
        // mt_transfer returns nothing; only success or failure matters, so read no bytes.
        let ok = env::promise_results_count() == 1
            && !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let outcome = if ok { OpStatus::Settled } else { OpStatus::Failed };
        self.finish(op_id.0, outcome, env::block_timestamp(), "callback");
    }

    // ---- Views ----

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            intents: self.intents.clone(),
            policy: self.policy.clone(),
            next_op_id: U64(self.next_op_id),
        }
    }

    pub fn get_merchants(&self) -> Vec<Merchant> {
        self.merchants.clone()
    }

    pub fn get_op(&self, op_id: U64) -> Option<OpRecord> {
        if let Some(r) = self.active.iter().find(|r| r.op.op_id == op_id) {
            return Some(r.clone());
        }
        self.recent_iter().find(|r| r.op.op_id == op_id)
    }

    /// Active and recent ops, newest first.
    pub fn list_ops(&self) -> Vec<OpRecord> {
        let mut ops: Vec<OpRecord> = self.active.iter().cloned().chain(self.recent_iter()).collect();
        ops.sort_by_key(|r| std::cmp::Reverse(r.op.op_id.0));
        ops
    }

    pub fn budget(&self) -> Budget {
        let now = env::block_timestamp();
        let spent = self.spent_today(now);
        let reserved = self.reserved_today(now);
        let daily_max = self.policy.daily_max.0;
        Budget {
            day: U64(now / NS_PER_DAY),
            daily_max: U128(daily_max),
            spent: U128(spent),
            reserved: U128(reserved),
            remaining: U128(daily_max.saturating_sub(spent.saturating_add(reserved))),
        }
    }

    /// Policy preview for a request, as if the configured agent sent it now. Writes nothing.
    pub fn check_payment(&self, req: PaymentRequest) -> CheckResult {
        let now = env::block_timestamp();
        let remaining = self.budget().remaining.0;
        let reject = |code| CheckResult {
            decision: Decision::Reject,
            code: Some(code),
            remaining_after: U128(remaining),
        };
        if self.policy.paused {
            return reject(VaultError::Paused);
        }
        let dispatch_now = req.amount.0 <= self.policy.approval_threshold.0;
        if let Err(e) = self.check_request(&req, now, true, true, dispatch_now) {
            return reject(e);
        }
        if dispatch_now {
            CheckResult {
                decision: Decision::Allow,
                code: None,
                remaining_after: U128(remaining.saturating_sub(req.amount.0)),
            }
        } else {
            CheckResult {
                decision: Decision::NeedsApproval,
                code: None,
                remaining_after: U128(remaining),
            }
        }
    }
}

impl Vault {
    fn require_owner(&self) {
        if env::predecessor_account_id() != self.owner {
            fail(VaultError::NotOwner);
        }
    }

    fn awaiting(&self, op_id: u64) -> Option<&OpRecord> {
        self.active
            .iter()
            .find(|r| r.op.op_id.0 == op_id && r.status == OpStatus::AwaitingApproval)
    }

    /// Field and limit checks shared by `request_payment`, `approve` and `check_payment`, in the
    /// spec's order. `new_slot` is false for approval, which moves a slot rather than adding one.
    fn check_request(
        &self,
        req: &PaymentRequest,
        now: u64,
        check_ttl: bool,
        new_slot: bool,
        check_daily: bool,
    ) -> Result<(), VaultError> {
        let p = &self.policy;
        if req.policy_version != p.version {
            return Err(VaultError::PolicyVersionMismatch);
        }
        if now >= req.expires_at_ns.0 {
            return Err(VaultError::Expired);
        }
        if check_ttl && req.expires_at_ns.0 - now > u64::from(p.max_ttl_sec) * NS_PER_SEC {
            return Err(VaultError::TtlTooLong);
        }
        if !self.merchants.iter().any(|m| m.account_id == req.merchant_id) {
            return Err(VaultError::MerchantNotAllowed);
        }
        if req.token_id != p.token_id {
            return Err(VaultError::WrongToken);
        }
        if req.amount.0 == 0 {
            return Err(VaultError::ZeroAmount);
        }
        if req.invoice_ref.len() > MAX_INVOICE_REF_LEN {
            return Err(VaultError::InvoiceRefTooLong);
        }
        if req.amount.0 > p.per_payment_max.0 {
            return Err(VaultError::OverPerPayment);
        }
        if new_slot && self.effective_pending(now) + 1 > usize::from(p.max_pending) {
            return Err(VaultError::TooManyPending);
        }
        if check_daily {
            let used = self.spent_today(now).checked_add(self.reserved_today(now));
            match used.and_then(|u| u.checked_add(req.amount.0)) {
                Some(total) if total <= p.daily_max.0 => {}
                _ => return Err(VaultError::OverDaily),
            }
        }
        Ok(())
    }

    /// Dispatched ops plus awaiting ops not yet expired. Expired ones never hold a slot (T15).
    /// A new op is stored only after cleanup removes expired ones, so `active` never exceeds
    /// `max_pending <= MAX_ACTIVE`.
    fn effective_pending(&self, now: u64) -> usize {
        self.active
            .iter()
            .filter(|r| match r.status {
                OpStatus::Dispatched => true,
                OpStatus::AwaitingApproval => now < r.op.req.expires_at_ns.0,
                _ => false,
            })
            .count()
    }

    fn spent_today(&self, now: u64) -> u128 {
        if self.today.0 == now / NS_PER_DAY {
            self.today.1
        } else {
            0
        }
    }

    fn reserved_today(&self, now: u64) -> u128 {
        let day = now / NS_PER_DAY;
        self.active
            .iter()
            .filter(|r| r.status == OpStatus::Dispatched && r.day.map(|d| d.0) == Some(day))
            .fold(0u128, |acc, r| acc.saturating_add(r.op.req.amount.0))
    }

    /// Reserves the op's amount on today's budget and sends the transfer. The memo lets the
    /// merchant tie the payment to its invoice.
    fn dispatch(&mut self, op_id: u64, now: u64) -> Promise {
        let day = now / NS_PER_DAY;
        let rec = self
            .active
            .iter_mut()
            .find(|r| r.op.op_id.0 == op_id)
            .unwrap_or_else(|| env::panic_str("dispatch: op not active"));
        rec.status = OpStatus::Dispatched;
        rec.day = Some(U64(day));
        rec.dispatched_ns = Some(U64(now));
        let req = rec.op.req.clone();
        emit("dispatched", json!({ "op_id": U64(op_id), "day": U64(day), "amount": req.amount }));
        ext_mt::ext(self.intents.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_MT_TRANSFER)
            .with_unused_gas_weight(0)
            .mt_transfer(
                req.merchant_id,
                req.token_id,
                req.amount,
                None,
                Some(format!("vault:{op_id}:{}", req.invoice_ref)),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SETTLED)
                    .with_unused_gas_weight(0)
                    .on_settled(U64(op_id)),
            )
    }

    /// The only way a dispatched op ends, from its callback or `release_stuck`. It acts only on
    /// an op still `Dispatched`, so each op changes the budget exactly once (T17).
    fn finish(&mut self, op_id: u64, outcome: OpStatus, now: u64, source: &str) {
        let Some(i) = self
            .active
            .iter()
            .position(|r| r.op.op_id.0 == op_id && r.status == OpStatus::Dispatched)
        else {
            emit(
                "late_resolution_ignored",
                json!({ "op_id": U64(op_id), "outcome": outcome, "source": source }),
            );
            return;
        };
        let mut rec = self.active.remove(i);
        let current = now / NS_PER_DAY;
        // A past day's spend no longer limits admission, so only today's is recorded.
        if outcome == OpStatus::Settled && rec.day.map(|d| d.0) == Some(current) {
            if self.today.0 != current {
                self.today = (current, 0);
            }
            self.today.1 = self.today.1.saturating_add(rec.op.req.amount.0);
        }
        rec.status = outcome;
        rec.finished_ns = Some(U64(now));
        emit(
            event_name(outcome),
            json!({ "op_id": U64(op_id), "amount": rec.op.req.amount, "source": source }),
        );
        self.store_recent(rec);
    }

    fn cleanup_expired(&mut self, now: u64) {
        self.reject_where(now, "expired", |r| now >= r.op.req.expires_at_ns.0);
    }

    /// Moves matching awaiting ops to `Rejected`.
    fn reject_where(&mut self, now: u64, reason: &str, pred: impl Fn(&OpRecord) -> bool) {
        let (gone, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.active)
            .into_iter()
            .partition(|r| r.status == OpStatus::AwaitingApproval && pred(r));
        self.active = keep;
        for mut rec in gone {
            rec.status = OpStatus::Rejected;
            rec.finished_ns = Some(U64(now));
            emit("rejected", json!({ "op_id": rec.op.op_id, "reason": reason }));
            self.store_recent(rec);
        }
    }

    /// Every owner change bumps the version and rejects awaiting ops built on the old one (T11).
    fn policy_changed(&mut self, change: &str) {
        self.policy.version += 1;
        let now = env::block_timestamp();
        self.reject_where(now, "policy_changed", |_| true);
        emit(
            "policy_changed",
            json!({ "change": change, "version": self.policy.version, "policy": self.policy }),
        );
    }

    fn store_recent(&mut self, rec: OpRecord) {
        self.recent.insert(self.finished_seq % RECENT, rec);
        self.finished_seq += 1;
    }

    fn recent_iter(&self) -> impl Iterator<Item = OpRecord> + '_ {
        (0..RECENT.min(self.finished_seq)).filter_map(|slot| self.recent.get(&slot).cloned())
    }
}

fn validated_policy(p: PolicyInput, version: u32, paused: bool) -> Policy {
    let ok = !p.token_id.is_empty()
        && p.token_id.len() <= MAX_TOKEN_ID_LEN
        && p.daily_max.0 > 0
        && p.per_payment_max.0 > 0
        && p.per_payment_max.0 <= p.daily_max.0
        && p.approval_threshold.0 <= p.per_payment_max.0
        && p.max_ttl_sec > 0
        && p.max_pending > 0
        && usize::from(p.max_pending) <= MAX_ACTIVE;
    if !ok {
        fail(VaultError::InvalidPolicy);
    }
    Policy {
        version,
        token_id: p.token_id,
        per_payment_max: p.per_payment_max,
        daily_max: p.daily_max,
        approval_threshold: p.approval_threshold,
        max_ttl_sec: p.max_ttl_sec,
        max_pending: p.max_pending,
        paused,
    }
}

/// Fails before anything is stored if the transfer and its callback could not both be paid for,
/// so a starved callback cannot strand a reservation (T17).
fn require_dispatch_gas() {
    let left = env::prepaid_gas().saturating_sub(env::used_gas());
    let need = GAS_MT_TRANSFER
        .saturating_add(GAS_ON_SETTLED)
        .saturating_add(GAS_SELF);
    if left < need {
        fail(VaultError::InsufficientGas);
    }
}

fn event_name(s: OpStatus) -> &'static str {
    match s {
        OpStatus::AwaitingApproval => "awaiting_approval",
        OpStatus::Dispatched => "dispatched",
        OpStatus::Settled => "settled",
        OpStatus::Failed => "failed",
        OpStatus::Rejected => "rejected",
        OpStatus::Released => "released",
    }
}

/// NEP-297 event; the permanent history, since records are kept only for RECENT ops.
fn emit(event: &str, data: Value) {
    let log = json!({
        "standard": "agent_vault",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}
