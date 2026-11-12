//! Replaces the testnet vault's agent: creates `<AGENT_NAME>.<root>` (default `agent2`) with fresh
//! restricted keys, deletes its creation key, points the vault at it with the owner's `set_agent`,
//! and rewrites target/testnet.json. This is the owner's recovery when the agent's keys are lost or
//! leaked; the vault, its funds, merchants and budget stay as they are. The old agent's keys keep
//! their gas allowance but the vault refuses them, since only the configured agent may request.
//!
//! Run with `TESTNET_ACCOUNT=<root>.testnet make testnet-agent` (optionally `AGENT_NAME=agent3`).

#[path = "../tests/common/mod.rs"]
mod common;

use anyhow::{bail, ensure, Context, Result};
use common::*;
use near_workspaces::types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;
use std::path::PathBuf;

const RPC: &str = "https://test.rpc.fastnear.com";
const WRAP: &str = "wrap.testnet";
const AGENT_NEAR: u128 = 1_000;

#[tokio::main]
async fn main() -> Result<()> {
    let root_id: AccountId = std::env::var("TESTNET_ACCOUNT").context("set TESTNET_ACCOUNT=<root>.testnet")?.parse()?;
    ensure!(root_id.as_str().ends_with(".testnet"), "{root_id} is not a testnet account");
    let name = std::env::var("AGENT_NAME").unwrap_or_else(|_| "agent2".into());
    let key_file = PathBuf::from(std::env::var("HOME")?).join(format!(".near-credentials/testnet/{root_id}.json"));

    let worker = near_workspaces::testnet().rpc_addr(RPC).await?;
    ensure!(worker.status().await?.chain_id == "testnet", "{RPC} is not testnet");
    let key_json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&key_file).with_context(|| format!("reading {}", key_file.display()))?)?;
    let sk: SecretKey = key_json.get("private_key").and_then(|v| v.as_str()).context("key file has no private_key")?.parse()?;
    let root = Account::from_secret_key(root_id.clone(), sk, &worker);

    let sub = |n: &str| -> Result<AccountId> { Ok(format!("{n}.{root_id}").parse()?) };
    let (vault, intents, shop, desk, attacker) = (sub("vault")?, sub("intents")?, sub("shop")?, sub("desk")?, sub("attacker")?);
    let agent_id = sub(&name)?;
    let config: serde_json::Value = worker.view(&vault, "get_config").await?.json()?;
    ensure!(config["owner"] == root_id.as_str(), "{vault} is not owned by {root_id}");
    if worker.view_account(&agent_id).await.is_ok() {
        bail!("{agent_id} already exists; pick another AGENT_NAME");
    }

    let agent = root
        .create_subaccount(&name)
        .initial_balance(NearToken::from_millinear(AGENT_NEAR))
        .keys(SecretKey::from_random(KeyType::ED25519))
        .transact()
        .await?
        .into_result()?;
    let mut agent_keys = Vec::new();
    for _ in 0..AGENT_KEYS {
        let k = SecretKey::from_random(KeyType::ED25519);
        agent
            .batch(agent.id())
            .add_key(k.public_key(), AccessKey::function_call_access(&vault, &["request_payment"], Some(NearToken::from_millinear(250))))
            .transact()
            .await?
            .into_result()?;
        agent_keys.push(k.to_string());
    }
    agent.batch(agent.id()).delete_key(agent.secret_key().public_key()).transact().await?.into_result()?;

    root.call(&vault, "set_agent").args_json(json!({ "agent": agent_id })).deposit(ONE_YOCTO).transact().await?.into_result()?;

    let keys = worker.view_access_keys(&agent_id).await?;
    ensure!(keys.len() == AGENT_KEYS, "{agent_id} has {} keys, expected {AGENT_KEYS}", keys.len());
    for k in &keys {
        match &k.access_key.permission {
            AccessKeyPermission::FunctionCall(fc) => ensure!(
                fc.receiver_id == vault.as_str() && fc.method_names == ["request_payment"],
                "{agent_id} has a key for {}::{:?}",
                fc.receiver_id,
                fc.method_names
            ),
            AccessKeyPermission::FullAccess => bail!("{agent_id} still has a full-access key"),
        }
    }
    let config: serde_json::Value = worker.view(&vault, "get_config").await?.json()?;
    ensure!(config["agent"] == agent_id.as_str(), "vault agent is {}", config["agent"]);
    println!("vault {vault} now takes requests only from {agent_id} ({AGENT_KEYS} restricted keys)");

    let out = json!({
        "network": "testnet",
        "rpc_url": RPC,
        "vault_id": vault,
        "intents_id": intents,
        "token_id": format!("nep141:{WRAP}"),
        "owner_id": root_id,
        "owner_key_file": key_file,
        "agent_id": agent_id,
        "agent_keys": agent_keys,
        "merchant_id": shop,
        "merchant2_id": desk,
        "attacker_id": attacker,
        "keys": {
            "vault": [], "intents": [], "shop": [], "desk": [], "attacker": [],
            "agent": format!("{AGENT_KEYS} function-call keys, receiver {vault}, method request_payment"),
        },
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/testnet.json");
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, serde_json::to_string_pretty(&out)?)?;
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    println!("wrote {}", path.display());
    Ok(())
}
