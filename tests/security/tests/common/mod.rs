//! Sandbox harness: the bootstrap in docs/acceptance.md against the pinned mainnet binaries.
#![allow(dead_code)]

use anyhow::{bail, ensure, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, CryptoHash, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const W: u128 = 1_000_000_000_000_000_000_000_000; // 1 wNEAR
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const AGENT_KEYS: usize = 8;

/// `hundredths` of a wNEAR, in base units.
pub fn w(hundredths: u128) -> u128 {
    W / 100 * hundredths
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub dao: Account,
    pub owner: Account,
    pub agent: Account,
    /// Function-call keys of `agent`: receiver the vault, method `request_payment` only.
    pub agent_keys: Vec<Account>,
    pub shop: Account,
    pub attacker: Account,
    pub outsider: Account,
    pub wrap: Contract,
    pub intents: Contract,
    pub vault: AccountId,
    pub token: String,
}

fn fixture(name: &str) -> Result<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures").join(name);
    std::fs::read(&path).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// Pinned binaries, checked against tests/fixtures/SOURCE.md before use.
fn pinned(name: &str) -> Result<Vec<u8>> {
    let wasm = fixture(name)?;
    let hex = format!("{:x}", Sha256::digest(&wasm));
    let source = String::from_utf8(fixture("SOURCE.md")?)?;
    ensure!(
        source.lines().any(|l| l.contains(&format!("`{name}`")) && l.contains(&hex)),
        "{name} does not match tests/fixtures/SOURCE.md (sha256 {hex})"
    );
    Ok(wasm)
}

/// The vault wasm, built by `make build` (cargo near, release profile).
pub fn vault_wasm(test_gas: bool) -> Result<Vec<u8>> {
    let dir = if test_gas { "near-test-gas" } else { "near" };
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target")
        .join(dir)
        .join("policy_vault/policy_vault.wasm");
    std::fs::read(&path).map_err(|e| anyhow::anyhow!("{}: {e}; run `make build` first", path.display()))
}

pub fn policy(token: &str) -> Value {
    json!({
        "token_id": token,
        "per_payment_max": w(100).to_string(),
        "daily_max": w(300).to_string(),
        "approval_threshold": w(25).to_string(),
        "max_ttl_sec": 600,
        "max_pending": 4,
    })
}

async fn subaccount(parent: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

pub async fn setup() -> Result<Env> {
    setup_with(false).await
}

pub async fn setup_with(test_gas: bool) -> Result<Env> {
    setup_custom(test_gas, None).await
}

/// `policy`: overrides the fixture policy (the devnet uses the demo's scaled-down one).
pub async fn setup_custom(test_gas: bool, policy_override: Option<Value>) -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let dao = subaccount(&root, "dao", 50).await?;
    let owner = subaccount(&root, "owner", 100).await?;
    let agent = subaccount(&root, "agent", 20).await?;
    let shop = subaccount(&root, "shop", 10).await?;
    let attacker = subaccount(&root, "attacker", 10).await?;
    let outsider = subaccount(&root, "outsider", 10).await?;

    // 1. wNEAR
    let wrap = subaccount(&root, "wrap", 50).await?.deploy(&pinned("wrap.wasm")?).await?.into_result()?;
    wrap.call("new").transact().await?.into_result()?;

    // 2. Intents, initialised fresh with `dao` holding the roles the failure tests need.
    let intents = subaccount(&root, "intents", 50)
        .await?
        .deploy(&pinned("intents.wasm")?)
        .await?
        .into_result()?;
    intents
        .call("new")
        .args_json(json!({ "config": {
            "wnear_id": wrap.id(),
            "fees": { "fee": 0, "fee_collector": dao.id() },
            "roles": {
                "super_admins": [dao.id()],
                "admins": {},
                "grantees": {
                    "PauseManager": [dao.id()],
                    "UnpauseManager": [dao.id()],
                    "UnrestrictedAccountLocker": [dao.id()],
                    "UnrestrictedAccountUnlocker": [dao.id()],
                },
            },
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 3. Storage on wNEAR for Intents and the owner; the owner wraps 20 NEAR.
    for acct in [intents.id(), owner.id()] {
        owner
            .call(wrap.id(), "storage_deposit")
            .args_json(json!({ "account_id": acct }))
            .deposit(NearToken::from_millinear(125))
            .transact()
            .await?
            .into_result()?;
    }
    owner
        .call(wrap.id(), "near_deposit")
        .deposit(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    ensure!(ft_balance(&wrap, owner.id()).await? == 20 * W, "owner wNEAR after wrapping");

    let token = format!("nep141:{}", wrap.id());
    let vault: AccountId = format!("vault.{}", owner.id()).parse()?;

    // 4. The vault, created, funded, deployed and initialised in one transaction, no AddKey (T23).
    owner
        .batch(&vault)
        .create_account()
        .transfer(NearToken::from_near(5))
        .deploy(&vault_wasm(test_gas)?)
        .call(Function::new("new").args_json(json!({
            "owner": owner.id(),
            "agent": agent.id(),
            "intents": intents.id(),
            "policy": policy_override.unwrap_or_else(|| policy(&token)),
            "merchants": [{ "account_id": shop.id(), "label": "Report Shop" }],
        })))
        .transact()
        .await?
        .into_result()?;

    // 5. Fund the vault's Intents balance.
    owner
        .call(wrap.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": intents.id(), "amount": (10 * W).to_string(), "msg": vault }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // 6. The agent's restricted keys.
    let mut agent_keys = Vec::new();
    for _ in 0..AGENT_KEYS {
        let sk = SecretKey::from_random(KeyType::ED25519);
        agent
            .batch(agent.id())
            .add_key(
                sk.public_key(),
                AccessKey::function_call_access(&vault, &["request_payment"], Some(NearToken::from_millinear(250))),
            )
            .transact()
            .await?
            .into_result()?;
        agent_keys.push(Account::from_secret_key(agent.id().clone(), sk, &worker));
    }

    let env = Env { worker, dao, owner, agent, agent_keys, shop, attacker, outsider, wrap, intents, vault, token };
    ensure!(env.balance(&env.vault).await? == 10 * W, "vault Intents balance after funding");
    Ok(env)
}

pub async fn ft_balance(wrap: &Contract, who: &AccountId) -> Result<u128> {
    let s: String = wrap.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(s.parse()?)
}

impl Env {
    /// Intents balance of `who` in the vault's token.
    pub async fn balance(&self, who: &AccountId) -> Result<u128> {
        let s: String = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({ "account_id": who, "token_id": self.token }))
            .await?
            .json()?;
        Ok(s.parse()?)
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.worker.view(&self.vault, method).args_json(args).await?.json()?)
    }

    pub async fn budget(&self) -> Result<(u128, u128)> {
        let b = self.view("budget", json!({})).await?;
        Ok((b["spent"].as_str().unwrap().parse()?, b["reserved"].as_str().unwrap().parse()?))
    }

    pub async fn op_status(&self, op_id: &str) -> Result<String> {
        let rec = self.view("get_op", json!({ "op_id": op_id })).await?;
        Ok(rec["status"].as_str().unwrap_or("missing").to_string())
    }

    pub async fn policy_version(&self) -> Result<u64> {
        Ok(self.view("get_config", json!({})).await?["policy"]["version"].as_u64().unwrap())
    }

    /// Produces blocks until chain time has moved at least `secs` seconds.
    pub async fn advance(&self, secs: u64) -> Result<()> {
        let target = self.now_ns().await? + secs * 1_000_000_000;
        while self.now_ns().await? < target {
            self.worker.fast_forward(20).await?;
        }
        Ok(())
    }

    pub async fn height(&self, block: CryptoHash) -> Result<u64> {
        Ok(self.worker.view_block().block_hash(block).await?.height())
    }

    pub async fn now_ns(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// A request to `merchant` that expires in five minutes.
    pub async fn req(&self, merchant: &AccountId, amount: u128) -> Result<Value> {
        let now = self.now_ns().await?;
        Ok(json!({
            "merchant_id": merchant,
            "token_id": self.token,
            "amount": amount.to_string(),
            "invoice_ref": "INV-1",
            "expires_at_ns": (now + 300 * 1_000_000_000).to_string(),
            "policy_version": self.policy_version().await?,
        }))
    }

    /// `request_payment` signed with agent key `key`.
    pub async fn request_with(&self, key: usize, req: Value) -> Result<ExecutionFinalResult> {
        Ok(self.agent_keys[key]
            .call(&self.vault, "request_payment")
            .args_json(json!({ "req": req }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn request(&self, merchant: &AccountId, amount: u128) -> Result<ExecutionFinalResult> {
        self.request_with(0, self.req(merchant, amount).await?).await
    }

    /// Requests and expects the vault to accept; returns the op.
    pub async fn pay(&self, amount: u128) -> Result<Value> {
        let res = self.request(self.shop.id(), amount).await?;
        Ok(res.into_result()?.json()?)
    }

    pub async fn owner_call(&self, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        Ok(self
            .owner
            .call(&self.vault, method)
            .args_json(args)
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// An Intents admin call as `dao`; `yocto` for methods that `assert_one_yocto`.
    pub async fn dao_call(&self, method: &str, args: Value, yocto: bool) -> Result<ExecutionFinalResult> {
        let deposit = if yocto { ONE_YOCTO } else { NearToken::from_yoctonear(0) };
        Ok(self
            .dao
            .call(self.intents.id(), method)
            .args_json(args)
            .deposit(deposit)
            .max_gas()
            .transact()
            .await?)
    }
}

/// The transaction's own call failed with the vault error `code`.
pub fn expect_err(res: ExecutionFinalResult, code: &str) -> Result<()> {
    match res.into_result() {
        Ok(_) => bail!("expected {code}, but the call succeeded"),
        Err(e) => {
            let text = format!("{e:?}");
            ensure!(text.contains(code), "expected {code}, got {text}");
            Ok(())
        }
    }
}

/// Vault events (NEP-297, standard agent_vault) named `event` in a result's logs.
pub fn events(res: &ExecutionFinalResult, event: &str) -> Vec<Value> {
    res.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .filter(|v| v["standard"] == "agent_vault" && v["event"] == event)
        .collect()
}

/// Text of a rejection, whether the network refused the transaction (for example an access key
/// that does not allow the call) or the transaction ran and failed.
pub fn rejection(res: anyhow::Result<ExecutionFinalResult>) -> String {
    match res {
        Err(e) => format!("{e:?}"),
        Ok(r) => match r.into_result() {
            Ok(_) => String::from("accepted"),
            Err(e) => format!("{e:?}"),
        },
    }
}

/// Every receipt of a transaction with its actions (RPC `EXPERIMENTAL_tx_status`), for checks the
/// execution outcomes cannot show: attached gas, refund deposits, predecessors.
pub async fn tx_receipts(env: &Env, res: &ExecutionFinalResult, sender: &AccountId) -> Result<Vec<Value>> {
    let body = json!({
        "jsonrpc": "2.0", "id": "t", "method": "EXPERIMENTAL_tx_status",
        "params": { "tx_hash": res.outcome().transaction_hash.to_string(), "sender_account_id": sender, "wait_until": "FINAL" },
    });
    let out: Value = reqwest::Client::new().post(env.worker.rpc_addr()).json(&body).send().await?.json().await?;
    Ok(out["result"]["receipts"].as_array().cloned().unwrap_or_default())
}

/// The actions of `receipt`, if it is an action receipt.
pub fn actions(receipt: &Value) -> Vec<Value> {
    receipt["receipt"]["Action"]["actions"].as_array().cloned().unwrap_or_default()
}
