//! Unit tests: policy checks, the `finish` state machine and budget arithmetic. Cross-contract
//! behaviour against the real Intents contract lives in `tests/security`. Test names carry the
//! threat id they cover.

use super::*;
#[allow(deprecated)] // the replacement, `testing_env!` with five arguments, needs near-parameters types
use near_sdk::test_utils::{get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};
use std::panic::{catch_unwind, AssertUnwindSafe};

const W: u128 = 1_000_000_000_000_000_000_000_000; // 1 wNEAR (24 decimals)
const TOKEN: &str = "nep141:wrap.near";
/// Noon UTC on some day, so a few minutes either way stays on the same day.
const T0: u64 = 20_000 * NS_PER_DAY + NS_PER_DAY / 2;
const MIN: u64 = 60 * NS_PER_SEC;

fn w(hundredths: u128) -> U128 {
    U128(W / 100 * hundredths)
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn context(pred: &str, now: u64, deposit: u128, tgas: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.owner.near"))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(tgas));
    b
}

fn as_(pred: &str, now: u64) {
    testing_env!(context(pred, now, 0, 100).build());
}

fn as_owner(now: u64) {
    testing_env!(context("owner.near", now, 1, 100).build());
}

fn policy() -> PolicyInput {
    PolicyInput {
        token_id: TOKEN.into(),
        per_payment_max: w(100),
        daily_max: w(300),
        approval_threshold: w(25),
        max_ttl_sec: 600,
        max_pending: 4,
    }
}

fn setup() -> Vault {
    as_("owner.near", T0);
    Vault::new(
        acc("owner.near"),
        acc("agent.near"),
        acc("intents.near"),
        policy(),
        vec![Merchant { account_id: acc("shop.near"), label: "Report Shop".into() }],
    )
}

fn req(amount: U128, now: u64) -> PaymentRequest {
    PaymentRequest {
        merchant_id: acc("shop.near"),
        token_id: TOKEN.into(),
        amount,
        invoice_ref: "INV-1".into(),
        expires_at_ns: U64(now + 5 * MIN),
        policy_version: 1,
    }
}

fn request(v: &mut Vault, r: PaymentRequest, now: u64) -> PaymentOp {
    as_("agent.near", now);
    v.request_payment(r)
}

fn settle(v: &mut Vault, op: &PaymentOp, now: u64, ok: bool) {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    #[allow(deprecated)]
    testing_env_with_promise_results(
        context("vault.owner.near", now, 0, 100).build(),
        result,
    );
    v.on_settled(op.op_id);
}

fn pay(v: &mut Vault, amount: U128, now: u64) -> PaymentOp {
    let op = request(v, req(amount, now), now);
    settle(v, &op, now, true);
    op
}

/// Runs `f`, expecting a contract panic, and returns its message. The mocked chain reports a
/// contract panic as `HostError(GuestPanic { panic_msg: "..." })`; this returns the inner text.
fn err(f: impl FnOnce()) -> String {
    let p = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    let text = p
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match text.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.split_once('"').map_or(rest, |(m, _)| m).to_string(),
        None => text,
    }
}

fn status(v: &Vault, op: &PaymentOp) -> OpStatus {
    v.get_op(op.op_id).unwrap().status
}

fn spent_reserved(v: &Vault) -> (u128, u128) {
    let b = v.budget();
    (b.spent.0, b.reserved.0)
}

#[test]
fn small_payment_dispatches_then_settles() {
    let mut v = setup();
    let op = request(&mut v, req(w(24), T0), T0);
    assert_eq!(op.op_id, U64(1));
    assert_eq!(status(&v, &op), OpStatus::Dispatched);
    assert_eq!(spent_reserved(&v), (0, w(24).0));
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"dispatched""#)));

    settle(&mut v, &op, T0, true);
    assert_eq!(status(&v, &op), OpStatus::Settled);
    assert_eq!(spent_reserved(&v), (w(24).0, 0));
}

#[test]
fn failed_transfer_releases_budget() {
    let mut v = setup();
    let op = request(&mut v, req(w(24), T0), T0);
    settle(&mut v, &op, T0, false);
    assert_eq!(status(&v, &op), OpStatus::Failed);
    assert_eq!(spent_reserved(&v), (0, 0));
}

#[test]
fn t01_unlisted_merchant_rejected() {
    let mut v = setup();
    let mut r = req(w(10), T0);
    r.merchant_id = acc("attacker.near");
    assert_eq!(err(|| { request(&mut v, r, T0); }), "MerchantNotAllowed");
    assert!(v.list_ops().is_empty());
}

#[test]
fn t03b_only_agent_requests_and_only_owner_administers() {
    let mut v = setup();
    as_("owner.near", T0);
    assert_eq!(err(|| { v.request_payment(req(w(10), T0)); }), "NotAgent");

    let op = request(&mut v, req(w(50), T0), T0);
    let agent = |v: &mut Vault, f: &dyn Fn(&mut Vault)| {
        testing_env!(context("agent.near", T0, 1, 100).build());
        err(AssertUnwindSafe(|| f(v)))
    };
    assert_eq!(agent(&mut v, &|v| v.approve(op.clone())), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.reject(op.op_id)), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.set_policy(policy())), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.set_agent(acc("agent.near"))), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.remove_merchant(acc("shop.near"))), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.pause()), "NotOwner");
    assert_eq!(agent(&mut v, &|v| v.withdraw(w(1)).detach()), "NotOwner");
    assert_eq!(
        agent(&mut v, &|v| v.release_stuck(op.op_id, StuckOutcome::Released)),
        "NotOwner"
    );
}

#[test]
fn owner_methods_need_one_yocto() {
    let mut v = setup();
    as_("owner.near", T0);
    assert!(err(|| v.pause()).contains("1 yoctoNEAR"));
}

#[test]
fn t04_daily_limit_over_many_small_payments() {
    let mut v = setup();
    for _ in 0..12 {
        pay(&mut v, w(24), T0);
    }
    assert_eq!(v.budget().spent, w(288));
    assert_eq!(err(|| { request(&mut v, req(w(24), T0), T0); }), "OverDaily");
}

#[test]
fn t05_t06_reservation_counts_against_the_limit() {
    let mut v = setup();
    for _ in 0..11 {
        pay(&mut v, w(24), T0);
    }
    let first = request(&mut v, req(w(24), T0), T0); // in flight, not settled
    assert_eq!(spent_reserved(&v), (w(264).0, w(24).0));
    assert_eq!(err(|| { request(&mut v, req(w(24), T0), T0); }), "OverDaily");
    settle(&mut v, &first, T0, true);
    assert_eq!(spent_reserved(&v), (w(288).0, 0));
}

#[test]
fn t08_resubmission_is_a_new_payment() {
    let mut v = setup();
    let a = pay(&mut v, w(24), T0);
    let b = pay(&mut v, w(24), T0);
    assert_ne!(a.op_id, b.op_id);
    assert_eq!(v.budget().spent, w(48));
}

#[test]
fn t09_approval_bound_to_every_field() {
    let mut v = setup();
    let op = request(&mut v, req(w(50), T0), T0);
    let other = request(&mut v, req(w(60), T0), T0);
    assert_eq!(status(&v, &op), OpStatus::AwaitingApproval);
    assert_eq!(spent_reserved(&v), (0, 0));

    let mutations: Vec<fn(&mut PaymentOp)> = vec![
        |o| o.req.merchant_id = acc("attacker.near"),
        |o| o.req.token_id = "nep141:usdc.near".into(),
        |o| o.req.amount = w(90),
        |o| o.req.invoice_ref = "INV-2".into(),
        |o| o.req.expires_at_ns = U64(o.req.expires_at_ns.0 + 1),
        |o| o.req.policy_version = 2,
        |o| o.op_id = U64(2), // the other awaiting op's id with this op's fields
    ];
    for m in mutations {
        let mut forged = op.clone();
        m(&mut forged);
        as_owner(T0);
        assert_eq!(err(|| v.approve(forged)), "ApprovalMismatch");
    }
    let mut missing = op.clone();
    missing.op_id = U64(99);
    as_owner(T0);
    assert_eq!(err(|| v.approve(missing)), "NotAwaitingApproval");
    assert_eq!(status(&v, &op), OpStatus::AwaitingApproval);
    assert_eq!(status(&v, &other), OpStatus::AwaitingApproval);

    as_owner(T0);
    v.approve(op.clone());
    assert_eq!(status(&v, &op), OpStatus::Dispatched);
    assert_eq!(v.get_op(op.op_id).unwrap().day, Some(U64(T0 / NS_PER_DAY)));
}

#[test]
fn t10_approval_single_use() {
    let mut v = setup();
    let op = request(&mut v, req(w(50), T0), T0);
    as_owner(T0);
    v.approve(op.clone());
    as_owner(T0);
    assert_eq!(err(|| v.approve(op.clone())), "NotAwaitingApproval");
    assert_eq!(v.budget().reserved, w(50));
}

#[test]
fn t11_policy_change_rejects_awaiting() {
    let mut v = setup();
    let op = request(&mut v, req(w(50), T0), T0);
    as_owner(T0);
    v.set_policy(PolicyInput { daily_max: w(200), ..policy() });
    assert_eq!(status(&v, &op), OpStatus::Rejected);
    as_owner(T0);
    assert_eq!(err(|| v.approve(op.clone())), "NotAwaitingApproval");
    assert_eq!(v.get_config().policy.version, 2);
}

#[test]
fn t12_approval_cannot_lift_daily_limit() {
    let mut v = setup();
    for _ in 0..10 {
        pay(&mut v, w(24), T0);
    }
    let op = request(&mut v, req(w(50), T0), T0); // 2.40 + 0.50 fits, awaits
    pay(&mut v, w(24), T0); // 2.64 spent
    as_owner(T0);
    assert_eq!(err(|| v.approve(op.clone())), "OverDaily");
    assert_eq!(status(&v, &op), OpStatus::AwaitingApproval);
}

#[test]
fn t12b_over_per_payment_never_awaits() {
    let mut v = setup();
    assert_eq!(err(|| { request(&mut v, req(w(110), T0), T0); }), "OverPerPayment");
}

#[test]
fn t13_expiry_and_ttl() {
    let mut v = setup();
    let mut past = req(w(10), T0);
    past.expires_at_ns = U64(T0);
    assert_eq!(err(|| { request(&mut v, past, T0); }), "Expired");

    let mut far = req(w(10), T0);
    far.expires_at_ns = U64(T0 + 11 * MIN);
    assert_eq!(err(|| { request(&mut v, far, T0); }), "TtlTooLong");

    let op = request(&mut v, req(w(50), T0), T0);
    as_owner(T0 + 6 * MIN);
    assert_eq!(err(|| v.approve(op.clone())), "Expired");
}

#[test]
fn t14_field_checks() {
    let mut v = setup();
    type Case = (fn(&mut PaymentRequest), &'static str);
    let cases: Vec<Case> = vec![
        (|r| r.token_id = "nep141:usdc.near".into(), "WrongToken"),
        (|r| r.amount = U128(0), "ZeroAmount"),
        (|r| r.invoice_ref = "x".repeat(65), "InvoiceRefTooLong"),
        (|r| r.policy_version = 7, "PolicyVersionMismatch"),
    ];
    for (m, code) in cases {
        let mut r = req(w(10), T0);
        m(&mut r);
        assert_eq!(err(|| { request(&mut v, r, T0); }), code);
    }
    let mut ok = req(w(10), T0);
    ok.invoice_ref = "x".repeat(64);
    request(&mut v, ok, T0);
}

#[test]
fn t15a_pending_cap_ignores_expired_and_allows_approval_when_full() {
    let mut v = setup();
    let ops: Vec<_> = (0..4).map(|_| request(&mut v, req(w(50), T0), T0)).collect();
    assert_eq!(err(|| { request(&mut v, req(w(50), T0), T0); }), "TooManyPending");

    as_owner(T0);
    v.approve(ops[0].clone()); // full queue: approval moves a slot, adds none

    // The other three expire. Admission ignores them without any cleanup having run.
    let later = T0 + 6 * MIN;
    let fresh = request(&mut v, req(w(50), later), later);
    assert_eq!(status(&v, &fresh), OpStatus::AwaitingApproval);
    for op in &ops[1..] {
        assert_eq!(status(&v, op), OpStatus::Rejected);
    }
}

/// The mocked chain's `storage_usage` restarts with each context, so this measures the stored
/// records themselves; the sandbox test measures the account's real storage.
#[test]
fn t15b_storage_stays_bounded() {
    let mut v = setup();
    let mut now = T0;
    let mut sizes = Vec::new();
    for cycle in 0..500 {
        for _ in 0..4 {
            request(&mut v, req(w(50), now), now);
        }
        now += 6 * MIN; // all four expire
        let op = request(&mut v, req(w(10), now), now);
        settle(&mut v, &op, now, cycle % 50 == 0); // mostly failed transfers
        if cycle == 100 || cycle == 499 {
            let ring: usize = (0..RECENT + 8)
                .filter_map(|k| v.recent.get(&k))
                .map(|r| near_sdk::borsh::to_vec(r).unwrap().len())
                .sum();
            sizes.push((v.active.len(), ring));
        }
    }
    assert_eq!(v.finished_seq, 2500);
    assert_eq!(sizes[0], sizes[1], "stored records grew between cycle 100 and 499");
    assert!(v.list_ops().len() <= MAX_ACTIVE + RECENT as usize);
}

#[test]
fn t15c_set_agent_frees_awaiting_slots() {
    let mut v = setup();
    let ops: Vec<_> = (0..4).map(|_| request(&mut v, req(w(50), T0), T0)).collect();
    as_owner(T0);
    v.set_agent(acc("agent2.near"));
    assert!(ops.iter().all(|op| status(&v, op) == OpStatus::Rejected));
    as_("agent.near", T0);
    assert_eq!(err(|| { v.request_payment(req(w(10), T0)); }), "NotAgent");
}

#[test]
fn t15c_lowered_cap_blocks_until_drained() {
    let mut v = setup();
    let ops: Vec<_> = (0..3).map(|_| request(&mut v, req(w(10), T0), T0)).collect();
    as_owner(T0);
    v.set_policy(PolicyInput { max_pending: 2, ..policy() });
    let mut r = req(w(10), T0);
    r.policy_version = 2;
    assert_eq!(err(|| { request(&mut v, r.clone(), T0); }), "TooManyPending");
    settle(&mut v, &ops[0], T0, true);
    assert_eq!(err(|| { request(&mut v, r.clone(), T0); }), "TooManyPending");
    settle(&mut v, &ops[1], T0, true);
    request(&mut v, r, T0);
}

#[test]
fn t17a_finish_acts_once_in_every_order() {
    let mut v = setup();
    let a = request(&mut v, req(w(20), T0), T0);
    let b = request(&mut v, req(w(25), T0), T0); // unrelated reservation throughout
    let c = request(&mut v, req(w(10), T0), T0);

    as_owner(T0 + MIN);
    assert_eq!(err(|| v.release_stuck(a.op_id, StuckOutcome::Released)), "NotStuckYet");

    // Recovery, then a late callback: the callback changes nothing.
    let late = T0 + 11 * MIN;
    as_owner(late);
    v.release_stuck(a.op_id, StuckOutcome::Released);
    assert_eq!(spent_reserved(&v), (0, w(35).0));
    settle(&mut v, &a, late, true);
    assert_eq!(status(&v, &a), OpStatus::Released);
    assert_eq!(spent_reserved(&v), (0, w(35).0));
    assert!(get_logs().iter().any(|l| l.contains("late_resolution_ignored")));

    // Callback, then recovery: recovery is refused.
    settle(&mut v, &c, late, false);
    as_owner(late);
    assert_eq!(err(|| v.release_stuck(c.op_id, StuckOutcome::Settled)), "NotDispatched");
    assert_eq!(spent_reserved(&v), (0, w(25).0));

    // Recovery as settled charges once.
    as_owner(late);
    v.release_stuck(b.op_id, StuckOutcome::Settled);
    assert_eq!(spent_reserved(&v), (w(25).0, 0));
    settle(&mut v, &b, late, true);
    assert_eq!(spent_reserved(&v), (w(25).0, 0));
}

#[test]
fn t17c_insufficient_gas_stores_nothing() {
    let mut v = setup();
    testing_env!(context("agent.near", T0, 0, 30).build());
    assert_eq!(err(|| { v.request_payment(req(w(10), T0)); }), "InsufficientGas");
    assert!(v.list_ops().is_empty());
    assert_eq!(v.get_config().next_op_id, U64(1));
}

#[test]
fn t22_midnight_charges_the_day_of_dispatch() {
    let mut v = setup();
    let midnight = (T0 / NS_PER_DAY + 1) * NS_PER_DAY;
    let before = midnight - 10 * NS_PER_SEC;
    let after = midnight + 5 * NS_PER_SEC;

    for _ in 0..12 {
        pay(&mut v, w(24), before);
    }
    let old = request(&mut v, req(w(10), before), before); // reserved on the old day
    let waiting = request(&mut v, req(w(50), before), before);

    as_("agent.near", after);
    assert_eq!(v.budget().remaining, w(300)); // the new day starts empty
    settle(&mut v, &old, after, true);
    assert_eq!(v.budget().spent, U128(0)); // old day's spend does not leak into today

    as_owner(after);
    v.approve(waiting.clone());
    assert_eq!(v.get_op(waiting.op_id).unwrap().day, Some(U64(midnight / NS_PER_DAY)));
    for _ in 0..10 {
        pay(&mut v, w(24), after);
    }
    // Documented bound: 2.98 before midnight, up to 3.00 after.
    assert_eq!(v.budget().reserved, w(50));
    assert_eq!(v.budget().spent, w(240));
}

#[test]
fn arithmetic_boundaries_saturate() {
    let mut v = setup();
    for _ in 0..8 {
        pay(&mut v, w(24), T0);
    }
    let pending = request(&mut v, req(w(24), T0), T0);
    as_owner(T0);
    v.set_policy(PolicyInput { daily_max: w(100), per_payment_max: w(100), ..policy() });
    assert_eq!(v.budget().remaining, U128(0));

    let mut r = req(w(1), T0);
    r.policy_version = 2;
    as_("agent.near", T0);
    let check = v.check_payment(r);
    assert_eq!((check.decision, check.code), (Decision::Reject, Some(VaultError::OverDaily)));

    settle(&mut v, &pending, T0, true);
    assert_eq!(v.budget().spent, w(216));

    let mut huge = req(U128(u128::MAX), T0);
    huge.policy_version = 2;
    assert_eq!(err(|| { request(&mut v, huge, T0); }), "OverPerPayment");
}

#[test]
fn check_payment_previews_without_writing() {
    let v = setup();
    as_("anyone.near", T0);
    let allow = v.check_payment(req(w(10), T0));
    assert_eq!(allow.decision, Decision::Allow);
    assert_eq!(allow.remaining_after, w(290));
    assert_eq!(v.check_payment(req(w(50), T0)).decision, Decision::NeedsApproval);
    let mut bad = req(w(10), T0);
    bad.merchant_id = acc("attacker.near");
    assert_eq!(v.check_payment(bad).code, Some(VaultError::MerchantNotAllowed));
    assert_eq!(v.get_config().next_op_id, U64(1));
}

#[test]
fn pause_blocks_requests_and_approvals() {
    let mut v = setup();
    let op = request(&mut v, req(w(50), T0), T0);
    as_owner(T0);
    v.pause();
    assert_eq!(status(&v, &op), OpStatus::Rejected);
    assert_eq!(err(|| { request(&mut v, req(w(10), T0), T0); }), "Paused");
    as_owner(T0);
    v.unpause();
    let mut r = req(w(10), T0);
    r.policy_version = 3;
    request(&mut v, r, T0);
}

#[test]
fn owner_input_is_validated() {
    let mut v = setup();
    as_owner(T0);
    assert_eq!(
        err(|| v.set_policy(PolicyInput { approval_threshold: w(200), ..policy() })),
        "InvalidPolicy"
    );
    as_owner(T0);
    assert_eq!(err(|| v.set_policy(PolicyInput { max_pending: 17, ..policy() })), "InvalidPolicy");
    as_owner(T0);
    assert_eq!(
        err(|| v.add_merchant(Merchant { account_id: acc("shop.near"), label: "dup".into() })),
        "InvalidMerchant"
    );
    for i in 1..MAX_MERCHANTS {
        as_owner(T0);
        v.add_merchant(Merchant { account_id: acc(&format!("m{i}.near")), label: "m".into() });
    }
    as_owner(T0);
    assert_eq!(
        err(|| v.add_merchant(Merchant { account_id: acc("one-more.near"), label: "m".into() })),
        "TooManyMerchants"
    );
}

#[test]
fn list_ops_newest_first() {
    let mut v = setup();
    pay(&mut v, w(10), T0);
    request(&mut v, req(w(50), T0), T0);
    let ids: Vec<u64> = v.list_ops().iter().map(|r| r.op.op_id.0).collect();
    assert_eq!(ids, vec![2, 1]);
}
