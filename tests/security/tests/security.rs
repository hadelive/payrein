//! Security tests against the pinned mainnet Intents binary (docs/acceptance.md). Each test name
//! starts with the threat id it covers in docs/threat-model.md.

mod common;

use anyhow::{ensure, Result};
use common::*;
use near_workspaces::types::Gas;
use serde_json::{json, Value};

fn op_id(op: &Value) -> String {
    op["op_id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn t01_t02_unlisted_recipient_rejected() -> Result<()> {
    let env = setup().await?;
    expect_err(env.request(env.attacker.id(), w(10)).await?, "MerchantNotAllowed")?;
    assert_eq!(env.balance(&env.vault).await?, 10 * W);
    assert_eq!(env.balance(env.attacker.id()).await?, 0);
    assert!(env.view("list_ops", json!({})).await?.as_array().unwrap().is_empty());
    Ok(())
}

#[tokio::test]
async fn t03_agent_key_cannot_leave_its_scope() -> Result<()> {
    let env = setup().await?;
    let key = &env.agent_keys[0];

    let other_method = key
        .call(&env.vault, "withdraw")
        .args_json(json!({ "amount": (10 * W).to_string() }))
        .transact()
        .await;
    let text = rejection(other_method.map_err(Into::into));
    ensure!(text.contains("MethodNameMismatch"), "withdraw with agent key: {text}");

    let other_receiver = key
        .call(env.intents.id(), "mt_transfer")
        .args_json(json!({ "receiver_id": env.attacker.id(), "token_id": env.token, "amount": "1" }))
        .transact()
        .await;
    let text = rejection(other_receiver.map_err(Into::into));
    ensure!(text.contains("ReceiverMismatch"), "mt_transfer with agent key: {text}");

    let with_deposit = key
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": env.req(env.shop.id(), w(10)).await? }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .transact()
        .await;
    let text = rejection(with_deposit.map_err(Into::into));
    ensure!(text.contains("DepositWithFunctionCall"), "deposit with agent key: {text}");

    assert_eq!(env.balance(&env.vault).await?, 10 * W);
    Ok(())
}

#[tokio::test]
async fn t03b_outsiders_rejected_by_the_contract() -> Result<()> {
    let env = setup().await?;
    let req = env.req(env.shop.id(), w(10)).await?;
    let res = env
        .outsider
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": req }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    expect_err(res, "NotAgent")?;

    let calls = [
        ("withdraw", json!({ "amount": "1" })),
        ("set_agent", json!({ "agent": env.outsider.id() })),
        ("pause", json!({})),
        ("reject", json!({ "op_id": "1" })),
        ("remove_merchant", json!({ "account_id": env.shop.id() })),
    ];
    for (method, args) in calls {
        let res = env
            .outsider
            .call(&env.vault, method)
            .args_json(args)
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        expect_err(res, "NotOwner")?;
    }
    Ok(())
}

#[tokio::test]
async fn t04_drain_in_small_payments_stops_at_daily_limit() -> Result<()> {
    let env = setup().await?;
    for _ in 0..12 {
        env.pay(w(24)).await?;
    }
    expect_err(env.request(env.shop.id(), w(24)).await?, "OverDaily")?;
    assert_eq!(env.balance(env.shop.id()).await?, w(288));
    assert_eq!(env.budget().await?, (w(288), 0));
    Ok(())
}

/// Two requests race for the last 0.24 of the budget. Exactly one may dispatch, and the other
/// must be refused while the first is still in flight, which proves the reservation is counted.
#[tokio::test]
async fn t05_t06_overlapping_requests_cannot_oversubscribe() -> Result<()> {
    let env = setup().await?;
    for _ in 0..11 {
        env.pay(w(24)).await?;
    }
    let (a, b) = (env.req(env.shop.id(), w(24)).await?, env.req(env.shop.id(), w(24)).await?);
    let first = env.agent_keys[1]
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": a }))
        .gas(Gas::from_tgas(100))
        .transact_async()
        .await?;
    let second = env.agent_keys[2]
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": b }))
        .gas(Gas::from_tgas(100))
        .transact_async()
        .await?;
    let results = [first.await?, second.await?];

    let (won, lost): (Vec<_>, Vec<_>) = results.into_iter().partition(|r| r.is_success());
    ensure!(won.len() == 1 && lost.len() == 1, "expected one dispatch and one refusal");
    let lost_text = format!("{:?}", lost[0].clone().into_result().unwrap_err());
    ensure!(lost_text.contains("OverDaily"), "refusal was {lost_text}");

    // Overlap: the refused admission ran before the winner's settlement callback.
    let settled_in = won[0]
        .receipt_outcomes()
        .iter()
        .find(|o| o.executor_id == env.vault && o.logs.iter().any(|l| l.contains(r#""event":"settled""#)))
        .map(|o| o.block_hash)
        .expect("winner settled");
    let refused_in = lost[0]
        .receipt_outcomes()
        .iter()
        .find(|o| o.executor_id == env.vault)
        .map(|o| o.block_hash)
        .expect("refusal executed on the vault");
    let (settled_h, refused_h) = (env.height(settled_in).await?, env.height(refused_in).await?);
    ensure!(
        refused_h < settled_h,
        "overlap not achieved: refusal at {refused_h}, settlement at {settled_h}"
    );

    assert_eq!(env.budget().await?, (w(288), 0));
    assert_eq!(env.balance(env.shop.id()).await?, w(288));
    Ok(())
}

#[tokio::test]
async fn t07_callback_is_private() -> Result<()> {
    let env = setup().await?;
    let op = env.pay(w(10)).await?;
    let res = env
        .outsider
        .call(&env.vault, "on_settled")
        .args_json(json!({ "op_id": op_id(&op) }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    expect_err(res, "is private")?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Settled");
    assert_eq!(env.budget().await?, (w(10), 0));
    Ok(())
}

#[tokio::test]
async fn t08_resubmission_is_a_new_payment_within_limits() -> Result<()> {
    let env = setup().await?;
    let req = env.req(env.shop.id(), w(10)).await?;
    let a: Value = env.request_with(0, req.clone()).await?.into_result()?.json()?;
    let b: Value = env.request_with(0, req).await?.into_result()?.json()?;
    assert_ne!(op_id(&a), op_id(&b));
    assert_eq!(env.budget().await?, (w(20), 0));
    Ok(())
}

#[tokio::test]
async fn t09_t10_approval_binds_every_field_once() -> Result<()> {
    let env = setup().await?;
    let op = env.pay(w(50)).await?;
    let other = env.pay(w(60)).await?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "AwaitingApproval");
    assert_eq!(env.budget().await?, (0, 0));

    let mutations: [(&str, Value); 7] = [
        ("merchant_id", json!(env.attacker.id())),
        ("token_id", json!("nep141:usdc.near")),
        ("amount", json!(w(90).to_string())),
        ("invoice_ref", json!("INV-2")),
        ("expires_at_ns", json!("1")),
        ("policy_version", json!(2)),
        ("op_id", other["op_id"].clone()),
    ];
    for (field, value) in mutations {
        let mut forged = op.clone();
        forged[field] = value;
        expect_err(env.owner_call("approve", json!({ "op": forged })).await?, "ApprovalMismatch")?;
    }
    let mut missing = op.clone();
    missing["op_id"] = json!("99");
    expect_err(env.owner_call("approve", json!({ "op": missing })).await?, "NotAwaitingApproval")?;
    assert_eq!(env.balance(env.attacker.id()).await?, 0);

    env.owner_call("approve", json!({ "op": op })).await?.into_result()?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Settled");
    assert_eq!(env.balance(env.shop.id()).await?, w(50));

    expect_err(env.owner_call("approve", json!({ "op": op })).await?, "NotAwaitingApproval")?;
    assert_eq!(env.balance(env.shop.id()).await?, w(50));
    assert_eq!(env.op_status(&op_id(&other)).await?, "AwaitingApproval");
    Ok(())
}

#[tokio::test]
async fn t11_policy_change_rejects_awaiting() -> Result<()> {
    let env = setup().await?;
    let op = env.pay(w(50)).await?;
    let mut p = policy(&env.token);
    p["daily_max"] = json!(w(200).to_string());
    env.owner_call("set_policy", json!({ "policy": p })).await?.into_result()?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Rejected");
    expect_err(env.owner_call("approve", json!({ "op": op })).await?, "NotAwaitingApproval")?;
    assert_eq!(env.balance(env.shop.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn t12_approval_cannot_lift_the_daily_limit() -> Result<()> {
    let env = setup().await?;
    for _ in 0..10 {
        env.pay(w(24)).await?;
    }
    let op = env.pay(w(50)).await?;
    env.pay(w(24)).await?;
    expect_err(env.owner_call("approve", json!({ "op": op })).await?, "OverDaily")?;
    assert_eq!(env.balance(env.shop.id()).await?, w(264));
    Ok(())
}

#[tokio::test]
async fn t13_approval_after_expiry_refused() -> Result<()> {
    let env = setup().await?;
    let op = env.pay(w(50)).await?;
    env.advance(310).await?;
    expect_err(env.owner_call("approve", json!({ "op": op })).await?, "Expired")?;
    Ok(())
}

#[tokio::test]
async fn t15a_pending_cap_and_expiry() -> Result<()> {
    let env = setup().await?;
    let mut ops = Vec::new();
    for _ in 0..4 {
        ops.push(env.pay(w(50)).await?);
    }
    expect_err(env.request(env.shop.id(), w(50)).await?, "TooManyPending")?;

    env.owner_call("approve", json!({ "op": ops[0] })).await?.into_result()?;

    env.advance(310).await?; // the other three expire; no cleanup call is made
    let fresh = env.pay(w(50)).await?;
    assert_eq!(env.op_status(&op_id(&fresh)).await?, "AwaitingApproval");
    for op in &ops[1..] {
        assert_eq!(env.op_status(&op_id(op)).await?, "Rejected");
    }

    // A request that is then refused leaves state as it was.
    let before = env.view("list_ops", json!({})).await?;
    expect_err(env.request(env.attacker.id(), w(10)).await?, "MerchantNotAllowed")?;
    assert_eq!(env.view("list_ops", json!({})).await?, before);
    Ok(())
}

/// Cycles of expiring approval requests and failing transfers: the account's storage stops
/// growing once the ring of recent records is full, and the vault keeps working.
#[tokio::test]
async fn t15b_storage_soak() -> Result<()> {
    let env = setup().await?;
    env.owner_call("withdraw", json!({ "amount": (10 * W).to_string() })).await?.into_result()?;

    let mut usage = Vec::new();
    for cycle in 0..30 {
        for key in 0..4 {
            let mut req = env.req(env.shop.id(), w(50)).await?;
            req["expires_at_ns"] = json!((env.now_ns().await? + 3_000_000_000).to_string());
            env.request_with(key, req).await?.into_result()?;
        }
        env.advance(4).await?;
        let op = env.pay(w(10)).await?; // fails: the vault is empty
        assert_eq!(env.op_status(&op_id(&op)).await?, "Failed");
        if cycle == 15 || cycle == 29 {
            usage.push(env.worker.view_account(&env.vault).await?.storage_usage);
        }
    }
    println!("vault storage usage at cycles 15 and 29: {usage:?}");
    ensure!(usage[1] <= usage[0], "storage grew after the ring filled: {usage:?}");

    // Still works: fund, pay, reject, withdraw.
    env.owner
        .call(env.wrap.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.intents.id(), "amount": W.to_string(), "msg": env.vault }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let paid = env.pay(w(10)).await?;
    assert_eq!(env.op_status(&op_id(&paid)).await?, "Settled");
    let waiting = env.pay(w(50)).await?;
    env.owner_call("reject", json!({ "op_id": op_id(&waiting) })).await?.into_result()?;
    env.owner_call("withdraw", json!({ "amount": w(10).to_string() })).await?.into_result()?;
    assert_eq!(env.balance(&env.vault).await?, W - w(20));
    Ok(())
}

#[tokio::test]
async fn t15c_set_agent_frees_slots() -> Result<()> {
    let env = setup().await?;
    let mut ops = Vec::new();
    for _ in 0..4 {
        ops.push(env.pay(w(50)).await?);
    }
    env.owner_call("set_agent", json!({ "agent": env.outsider.id() })).await?.into_result()?;
    for op in &ops {
        assert_eq!(env.op_status(&op_id(op)).await?, "Rejected");
    }
    expect_err(env.request(env.shop.id(), w(10)).await?, "NotAgent")?;
    Ok(())
}

/// The payment and a withdrawal of everything land together. Whichever transfer wins, exactly one
/// of them moves funds, and the budget follows the payment's real outcome.
#[tokio::test]
async fn t16a_withdraw_racing_a_dispatch() -> Result<()> {
    let env = setup().await?;
    let pay = env.agent_keys[0]
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": env.req(env.shop.id(), w(20)).await? }))
        .gas(Gas::from_tgas(100))
        .transact_async()
        .await?;
    let drain = env
        .owner
        .call(&env.vault, "withdraw")
        .args_json(json!({ "amount": (10 * W).to_string() }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(100))
        .transact_async()
        .await?;
    let (pay, drain) = (pay.await?, drain.await?);
    let op: Value = pay.into_result()?.json()?; // admission itself must succeed
    let status = env.op_status(&op_id(&op)).await?;
    let withdrew = env.balance(env.owner.id()).await? == 10 * W;
    let drain_failed = drain.receipt_failures().iter().any(|o| &o.executor_id == env.intents.id());
    println!("t16a: payment {status}, withdrawal {}", if withdrew { "succeeded" } else { "failed" });

    match status.as_str() {
        "Settled" => {
            ensure!(!withdrew && drain_failed, "both transfers moved funds");
            assert_eq!(env.balance(env.shop.id()).await?, w(20));
            assert_eq!(env.budget().await?, (w(20), 0));
        }
        "Failed" => {
            ensure!(withdrew, "neither transfer moved funds");
            assert_eq!(env.balance(env.shop.id()).await?, 0);
            assert_eq!(env.budget().await?, (0, 0));
        }
        other => anyhow::bail!("payment ended {other}"),
    }
    Ok(())
}

#[tokio::test]
async fn t16b_intents_transfers_paused() -> Result<()> {
    let env = setup().await?;
    env.dao_call("pa_pause_feature", json!({ "key": "mt_transfer" }), false).await?.into_result()?;
    let op = env.pay(w(10)).await?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Failed");
    assert_eq!(env.budget().await?, (0, 0));
    Ok(())
}

#[tokio::test]
async fn t16c_vault_locked_in_intents() -> Result<()> {
    let env = setup().await?;
    env.dao_call("force_lock_account", json!({ "account_id": env.vault }), true).await?.into_result()?;
    let op = env.pay(w(10)).await?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Failed");
    assert_eq!(env.budget().await?, (0, 0));
    assert_eq!(env.balance(env.shop.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn t16d_locked_merchant_still_receives() -> Result<()> {
    let env = setup().await?;
    env.dao_call("force_lock_account", json!({ "account_id": env.shop.id() }), true).await?.into_result()?;
    let op = env.pay(w(10)).await?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Settled");
    assert_eq!(env.balance(env.shop.id()).await?, w(10));
    Ok(())
}

#[tokio::test]
async fn t16e_failed_transfer_refunds_the_yocto_to_the_vault() -> Result<()> {
    let env = setup().await?;
    env.owner_call("withdraw", json!({ "amount": (10 * W).to_string() })).await?.into_result()?;
    let res = env.request(env.shop.id(), w(10)).await?;
    assert_eq!(events(&res, "failed").len(), 1);

    let receipts = tx_receipts(&env, &res, env.agent.id()).await?;
    let attached: Vec<_> = receipts
        .iter()
        .filter(|r| r["receiver_id"] == json!(env.intents.id()))
        .flat_map(actions)
        .filter_map(|a| a["FunctionCall"]["deposit"].as_str().map(str::to_string))
        .collect();
    assert_eq!(attached, vec!["1"], "the vault attaches exactly 1 yocto to mt_transfer");
    // The runtime refunds a failed receipt's deposit to its predecessor, the vault.
    let refunds: Vec<_> = receipts
        .iter()
        .filter(|r| r["predecessor_id"] == "system" && r["receiver_id"] == json!(env.vault))
        .flat_map(actions)
        .filter_map(|a| a["Transfer"]["deposit"].as_str().map(str::to_string))
        .filter(|d| d != "0")
        .collect();
    assert_eq!(refunds, vec!["1"], "refund of the 1 yocto deposit to the vault");
    Ok(())
}

#[tokio::test]
async fn t17b_starved_callback_holds_budget_until_owner_recovery() -> Result<()> {
    let env = setup_with(true).await?;
    let res = env.request(env.shop.id(), w(10)).await?;
    let op: Value = res.clone().into_result()?.json()?;
    ensure!(!res.receipt_failures().is_empty(), "callback should have run out of gas");
    assert_eq!(env.balance(env.shop.id()).await?, w(10)); // merchant was paid
    assert_eq!(env.op_status(&op_id(&op)).await?, "Dispatched");
    assert_eq!(env.budget().await?, (0, w(10))); // held, fails closed

    let release = json!({ "op_id": op_id(&op), "outcome": "Settled" });
    expect_err(env.owner_call("release_stuck", release.clone()).await?, "NotStuckYet")?;
    env.advance(610).await?;
    env.owner_call("release_stuck", release.clone()).await?.into_result()?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Settled");
    assert_eq!(env.budget().await?, (w(10), 0)); // charged once, reservation freed
    expect_err(env.owner_call("release_stuck", release).await?, "NotDispatched")?;
    assert_eq!(env.budget().await?, (w(10), 0));
    Ok(())
}

#[tokio::test]
async fn t17c_insufficient_gas_stores_nothing() -> Result<()> {
    let env = setup().await?;
    let res = env.agent_keys[0]
        .call(&env.vault, "request_payment")
        .args_json(json!({ "req": env.req(env.shop.id(), w(10)).await? }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    expect_err(res, "InsufficientGas")?;
    assert!(env.view("list_ops", json!({})).await?.as_array().unwrap().is_empty());
    assert_eq!(env.budget().await?, (0, 0));
    Ok(())
}

/// Gas table for the evidence folder, measured with the vault's state at its bounds: 32 merchants,
/// a full ring of recent records, awaiting ops for cleanup to scan, and a 64-byte invoice. The
/// static allocations must cover each step twice, and the receipts must carry exactly them.
#[tokio::test]
async fn t17d_gas_table() -> Result<()> {
    let env = setup().await?;
    for i in 1..32 {
        env.owner_call("add_merchant", json!({ "merchant": { "account_id": format!("m{i}.test.near"), "label": "x".repeat(32) } }))
            .await?
            .into_result()?;
    }
    for _ in 0..70 {
        env.pay(w(1)).await?; // fills the recent ring
    }
    for _ in 0..3 {
        env.pay(w(50)).await?; // awaiting approval, scanned by cleanup
    }
    let mut req = env.req(env.shop.id(), w(1)).await?;
    req["invoice_ref"] = json!("x".repeat(64));
    let res = env.request_with(0, req).await?;
    let op: Value = res.clone().into_result()?.json()?;
    assert_eq!(env.op_status(&op_id(&op)).await?, "Settled");

    let burnt = |who: &near_workspaces::AccountId, nth: usize| {
        res.receipt_outcomes().iter().filter(|o| &o.executor_id == who).nth(nth).map(|o| o.gas_burnt.as_gas())
    };
    let request = burnt(&env.vault, 0).unwrap();
    let transfer = burnt(env.intents.id(), 0).unwrap();
    let callback = burnt(&env.vault, 1).unwrap();
    println!("gas burnt: request_payment {request}, mt_transfer {transfer}, on_settled {callback}");
    ensure!(transfer * 2 <= Gas::from_tgas(15).as_gas(), "mt_transfer {transfer}");
    ensure!(callback * 2 <= Gas::from_tgas(10).as_gas(), "on_settled {callback}");
    ensure!(request * 2 <= Gas::from_tgas(15).as_gas(), "request_payment {request}");

    // Unused-gas weight 0: each promise gets exactly its static gas, not a share of the rest.
    let receipts = tx_receipts(&env, &res, env.agent.id()).await?;
    let gas_of = |method: &str| -> Vec<u64> {
        receipts
            .iter()
            .flat_map(actions)
            .filter(|a| a["FunctionCall"]["method_name"] == method)
            .filter_map(|a| a["FunctionCall"]["gas"].as_u64())
            .collect()
    };
    assert_eq!(gas_of("mt_transfer"), vec![Gas::from_tgas(15).as_gas()]);
    assert_eq!(gas_of("on_settled"), vec![Gas::from_tgas(10).as_gas()]);
    Ok(())
}

#[tokio::test]
async fn t18_t19_vault_has_no_keys_anywhere() -> Result<()> {
    let env = setup().await?;
    env.pay(w(10)).await?;
    assert!(env.worker.view_access_keys(&env.vault).await?.is_empty());
    let keys: Value = env
        .intents
        .view("public_keys_of")
        .args_json(json!({ "account_id": env.vault }))
        .await?
        .json()?;
    assert_eq!(keys, json!([]));
    let auth: bool = env
        .intents
        .view("is_auth_by_predecessor_id_enabled")
        .args_json(json!({ "account_id": env.vault }))
        .await?
        .json()?;
    assert!(auth);
    Ok(())
}

#[tokio::test]
async fn t23_initialisation_cannot_be_repeated() -> Result<()> {
    let env = setup().await?;
    let args = json!({
        "owner": env.outsider.id(),
        "agent": env.outsider.id(),
        "intents": env.intents.id(),
        "policy": policy(&env.token),
        "merchants": [],
    });
    for who in [&env.owner, &env.outsider] {
        let res = who
            .call(&env.vault, "new")
            .args_json(args.clone())
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        expect_err(res, "already been initialized")?;
    }
    assert_eq!(env.view("get_config", json!({})).await?["owner"], json!(env.owner.id()));
    Ok(())
}

#[tokio::test]
async fn owner_withdraw_and_pause() -> Result<()> {
    let env = setup().await?;
    env.owner_call("pause", json!({})).await?.into_result()?;
    expect_err(env.request(env.shop.id(), w(10)).await?, "Paused")?;
    env.owner_call("withdraw", json!({ "amount": W.to_string() })).await?.into_result()?;
    assert_eq!(env.balance(env.owner.id()).await?, W);
    Ok(())
}
