//! Day-1 spike (docs/acceptance.md, Day-2 gate items 1, 2 and 4): the vault pays a merchant
//! from its own Intents balance, and the callback sees both outcomes.

mod common;

use anyhow::Result;
use common::*;
use serde_json::json;

#[tokio::test]
async fn vault_pays_from_its_intents_balance() -> Result<()> {
    let env = setup().await?;
    let res = env.request(env.shop.id(), w(10)).await?;
    for o in res.receipt_outcomes() {
        println!("{} burnt {} logs {:?}", o.executor_id, o.gas_burnt, o.logs);
    }
    let op: serde_json::Value = res.clone().into_result()?.json()?;
    assert_eq!(env.op_status(op["op_id"].as_str().unwrap()).await?, "Settled");
    assert_eq!(env.balance(env.shop.id()).await?, w(10));
    assert_eq!(env.balance(&env.vault).await?, 10 * W - w(10));
    assert_eq!(env.budget().await?, (w(10), 0));
    Ok(())
}

#[tokio::test]
async fn failed_transfer_is_released() -> Result<()> {
    let env = setup().await?;
    env.owner_call("withdraw", json!({ "amount": (10 * W).to_string() })).await?.into_result()?;
    assert_eq!(env.balance(&env.vault).await?, 0);

    let res = env.request(env.shop.id(), w(10)).await?;
    let op: serde_json::Value = res.clone().into_result()?.json()?;
    assert_eq!(events(&res, "failed").len(), 1);
    assert_eq!(env.op_status(op["op_id"].as_str().unwrap()).await?, "Failed");
    assert_eq!(env.budget().await?, (0, 0));
    assert_eq!(env.balance(env.shop.id()).await?, 0);
    Ok(())
}
