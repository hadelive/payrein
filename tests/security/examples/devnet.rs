//! Local devnet for the demo: the full bootstrap with the demo's scaled-down policy, kept running.
//! Writes target/devnet.json (RPC address, accounts, sandbox-only keys) for the agent runner,
//! the merchant and the owner app. Run with `make devnet`; stop with Ctrl-C.

#[path = "../tests/common/mod.rs"]
mod common;

use anyhow::Result;
use common::*;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    let token = "nep141:wrap.test.near";
    let demo_policy = json!({
        "token_id": token,
        "per_payment_max": w(1).to_string(),          // 0.01
        "daily_max": w(3).to_string(),                // 0.03
        "approval_threshold": (W / 200).to_string(),  // 0.005
        "max_ttl_sec": 600,
        "max_pending": 8,
    });
    let env = setup_custom(false, Some(demo_policy)).await?;
    assert_eq!(env.token, token);
    // The second merchant of the demo (T26), allowlisted like the first.
    let desk = subaccount(&env.worker.root_account()?, "desk", 10).await?;
    env.owner_call("add_merchant", json!({ "merchant": { "account_id": desk.id(), "label": "Data Desk" } }))
        .await?
        .into_result()?;

    let out = json!({
        "rpc_url": env.worker.rpc_addr(),
        "vault_id": env.vault,
        "intents_id": env.intents.id(),
        "token_id": env.token,
        "owner_id": env.owner.id(),
        "owner_key": env.owner.secret_key().to_string(),
        "agent_id": env.agent.id(),
        "agent_keys": env.agent_keys.iter().map(|a| a.secret_key().to_string()).collect::<Vec<_>>(),
        "merchant_id": env.shop.id(),
        "merchant2_id": desk.id(),
        "attacker_id": env.attacker.id(),
        "note": "sandbox-only keys; never use on a public network",
    });
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/devnet.json");
    std::fs::write(&path, serde_json::to_string_pretty(&out)?)?;
    println!("devnet ready: {} (vault {}, rpc {})", path.display(), env.vault, env.worker.rpc_addr());

    tokio::signal::ctrl_c().await?;
    Ok(())
}
