//! Testnet bootstrap for the demo. Testnet has no live Intents contract (`intents.testnet` holds no
//! code), so this deploys the pinned mainnet binary to `intents.<root>` and uses the live
//! `wrap.testnet` as the token. The funded testnet account `<root>` is the vault's owner and signs
//! approvals in a wallet; this program creates `intents.`, `agent.`, `shop.`, `attacker.` and `vault.`
//! under it and writes target/testnet.json (account ids, the agent's restricted keys, the path of the
//! owner's key file; never the owner's key itself).
//!
//! Run with `TESTNET_ACCOUNT=<root>.testnet make testnet` after `make build`. The key file defaults
//! to ~/.near-credentials/testnet/<root>.json (near-cli's legacy keychain); `TESTNET_KEY_FILE`
//! overrides it.

#[path = "../tests/common/mod.rs"]
mod common;

use anyhow::{bail, ensure, Context, Result};
use common::*;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;
use std::path::PathBuf;

const RPC: &str = "https://test.rpc.fastnear.com";
const WRAP: &str = "wrap.testnet";

// Native NEAR each new account starts with. Intents' 1.3 MB of code needs ~13 NEAR of storage.
const INTENTS_NEAR: u128 = 14_000;
const VAULT_NEAR: u128 = 2_500;
const AGENT_NEAR: u128 = 1_000;
const BYSTANDER_NEAR: u128 = 100;
/// The owner's wNEAR: 0.1 funds the vault, the rest stays with the owner.
const WRAP_NEAR: u128 = 200;
/// Needed in `<root>` before anything is spent: the accounts above, wNEAR, storage and gas.
const MIN_ROOT_NEAR: u128 = 18_500;

fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

#[tokio::main]
async fn main() -> Result<()> {
    let root_id: AccountId = std::env::var("TESTNET_ACCOUNT").context("set TESTNET_ACCOUNT=<root>.testnet")?.parse()?;
    ensure!(root_id.as_str().ends_with(".testnet"), "{root_id} is not a testnet account");
    let key_file = match std::env::var("TESTNET_KEY_FILE") {
        Ok(p) => PathBuf::from(p),
        Err(_) => PathBuf::from(std::env::var("HOME")?).join(format!(".near-credentials/testnet/{root_id}.json")),
    };

    let worker = near_workspaces::testnet().rpc_addr(RPC).await?;
    let chain = worker.status().await?.chain_id;
    ensure!(chain == "testnet", "{RPC} reports chain {chain}, not testnet");
    // The key file is near-cli's legacy keychain format. near-cli-rs writes `private_key` and no
    // `account_id`; the JS near-cli wrote both. Read the key ourselves and check it on chain.
    let key_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&key_file).with_context(|| format!("reading {}", key_file.display()))?,
    )?;
    if let Some(id) = key_json.get("account_id").and_then(|v| v.as_str()) {
        ensure!(id == root_id.as_str(), "{} holds the key of {id}, not {root_id}", key_file.display());
    }
    let sk: SecretKey = key_json
        .get("private_key")
        .or_else(|| key_json.get("secret_key"))
        .and_then(|v| v.as_str())
        .context("key file has no private_key")?
        .parse()?;
    let root = Account::from_secret_key(root_id.clone(), sk.clone(), &worker);
    let root_keys = worker.view_access_keys(&root_id).await?;
    ensure!(
        root_keys
            .iter()
            .any(|k| k.public_key == sk.public_key() && matches!(k.access_key.permission, AccessKeyPermission::FullAccess)),
        "{} holds a key that is not a full-access key on {root_id}",
        key_file.display()
    );

    // Everything is checked before the first transaction, so a refused run spends nothing.
    let sub = |name: &str| -> Result<AccountId> { Ok(format!("{name}.{root_id}").parse()?) };
    let vault = sub("vault")?;
    for id in ["intents", "agent", "shop", "attacker", "vault"].map(sub) {
        let id = id?;
        if worker.view_account(&id).await.is_ok() {
            bail!("{id} already exists; use a fresh root account");
        }
    }
    let have = worker.view_account(&root_id).await?.balance;
    ensure!(
        have >= milli(MIN_ROOT_NEAR),
        "{root_id} holds {} NEAR; this needs at least {} NEAR",
        have.as_near(),
        MIN_ROOT_NEAR / 1000
    );
    let wasm_intents = pinned("intents.wasm")?;
    let wasm_vault = vault_wasm(false)?;

    let create = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            let acct = root.create_subaccount(name).initial_balance(milli(near)).transact().await?.into_result()?;
            println!("created {}", acct.id());
            anyhow::Ok(acct)
        }
    };
    let agent = create("agent", AGENT_NEAR).await?;
    let shop = create("shop", BYSTANDER_NEAR).await?;
    let attacker = create("attacker", BYSTANDER_NEAR).await?;

    // 1. Our own Intents instance from the pinned mainnet binary; `<root>` holds its admin roles.
    let intents = create("intents", INTENTS_NEAR).await?.deploy(&wasm_intents).await?.into_result()?;
    intents
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": WRAP,
            "fees": { "fee": 0, "fee_collector": root_id },
            "roles": {
                "super_admins": [root_id],
                "admins": {},
                "grantees": {
                    "PauseManager": [root_id],
                    "UnpauseManager": [root_id],
                },
            },
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    println!("deployed the pinned Intents binary to {}", intents.id());

    // 2. wNEAR storage for Intents and the owner; the owner wraps 0.2 NEAR.
    let wrap: AccountId = WRAP.parse()?;
    for acct in [intents.id(), &root_id] {
        root.call(&wrap, "storage_deposit")
            .args_json(json!({ "account_id": acct }))
            .deposit(milli(125))
            .transact()
            .await?
            .into_result()?;
    }
    root.call(&wrap, "near_deposit").deposit(milli(WRAP_NEAR)).transact().await?.into_result()?;

    // 3. The vault with the demo policy: created, funded, deployed and initialised in one
    //    transaction, with no access key (T19, T23).
    let token = format!("nep141:{WRAP}");
    root.batch(&vault)
        .create_account()
        .transfer(milli(VAULT_NEAR))
        .deploy(&wasm_vault)
        .call(Function::new("new").args_json(json!({
            "owner": root_id,
            "agent": agent.id(),
            "intents": intents.id(),
            "policy": {
                "token_id": token,
                "per_payment_max": w(1).to_string(),         // 0.01
                "daily_max": w(3).to_string(),               // 0.03
                "approval_threshold": (W / 200).to_string(), // 0.005
                "max_ttl_sec": 600,
                "max_pending": 8,
            },
            "merchants": [{ "account_id": shop.id(), "label": "Report Shop" }],
        })))
        .transact()
        .await?
        .into_result()?;
    println!("created {vault}");

    // 4. 0.1 wNEAR into the vault's Intents balance.
    root.call(&wrap, "ft_transfer_call")
        .args_json(json!({ "receiver_id": intents.id(), "amount": (W / 10).to_string(), "msg": vault }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 5. The agent's restricted keys: the vault only, `request_payment` only, 0.25 NEAR of gas each.
    let mut agent_keys = Vec::new();
    for _ in 0..AGENT_KEYS {
        let sk = SecretKey::from_random(KeyType::ED25519);
        agent
            .batch(agent.id())
            .add_key(sk.public_key(), AccessKey::function_call_access(&vault, &["request_payment"], Some(milli(250))))
            .transact()
            .await?
            .into_result()?;
        agent_keys.push(sk.to_string());
    }

    // The vault must have no access key, and its Intents balance must be what was sent.
    let keys = worker.view_access_keys(&vault).await?;
    ensure!(keys.is_empty(), "{vault} has {} access keys", keys.len());
    let bal: String = worker
        .view(intents.id(), "mt_balance_of")
        .args_json(json!({ "account_id": vault, "token_id": token }))
        .await?
        .json()?;
    ensure!(bal == (W / 10).to_string(), "vault Intents balance {bal}");

    let out = json!({
        "network": "testnet",
        "rpc_url": RPC,
        "vault_id": vault,
        "intents_id": intents.id(),
        "token_id": token,
        "owner_id": root_id,
        "owner_key_file": key_file,
        "agent_id": agent.id(),
        "agent_keys": agent_keys,
        "merchant_id": shop.id(),
        "attacker_id": attacker.id(),
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/testnet.json");
    // Holds the agent's keys: owner-readable only.
    std::fs::write(&path, serde_json::to_string_pretty(&out)?)?;
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    println!("testnet ready: {} (vault {vault}, https://testnet.nearblocks.io/address/{vault})", path.display());
    Ok(())
}
