#!/usr/bin/env python3
"""Writes target/merchant.env, target/merchant2.env, target/agent.env and app/web/.env.local from target/<network>.json
(the agent's keys, and on devnet the sandbox owner key; all three are git-ignored). On testnet the
owner signs in a wallet, so no owner key is written.

Usage: python3 -I scripts/demo-env.py devnet|testnet [scripted|nearai]
"""

import json
import pathlib
import secrets
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
network = sys.argv[1] if len(sys.argv) > 1 else ""
if network not in ("devnet", "testnet"):
    sys.exit("usage: demo-env.py devnet|testnet [scripted|nearai]")
dev = json.loads((ROOT / f"target/{network}.json").read_text())
planner = sys.argv[2] if len(sys.argv) > 2 else "scripted"
api_token = secrets.token_hex(24)


def genesis_hash(rpc_url):
    body = json.dumps({"jsonrpc": "2.0", "id": "env", "method": "status", "params": []}).encode()
    req = urllib.request.Request(rpc_url, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["result"]["genesis_hash"]


# Devnet: read from the sandbox this launcher just started; the dev signers refuse any other chain.
genesis = genesis_hash(dev["rpc_url"]) if network == "devnet" else None

merchant = {
    "PORT": "8787",
    "RPC_URL": dev["rpc_url"],
    "MERCHANT_ID": dev["merchant_id"],
    "INTENTS_ID": dev["intents_id"],
    "VAULT_ID": dev["vault_id"],
    "TOKEN_ID": dev["token_id"],
    "DB_PATH": str(ROOT / f"target/merchant-{network}.sqlite"),
    # Demo T1: the merchant tries to redirect payment to the attacker in its invoice text.
    "INJECT_RECIPIENT": dev["attacker_id"],
}
# The second merchant, Data Desk: cheaper on the deep dive in its offer, but its invoice for it asks
# 0.009 instead of the quoted 0.006 (demo T26); the agent must refuse it and buy from Report Shop.
merchant2 = {
    "PORT": "8789",
    "RPC_URL": dev["rpc_url"],
    "MERCHANT_ID": dev["merchant2_id"],
    "INTENTS_ID": dev["intents_id"],
    "VAULT_ID": dev["vault_id"],
    "TOKEN_ID": dev["token_id"],
    "DB_PATH": str(ROOT / f"target/merchant2-{network}.sqlite"),
    "PRICES_MILLI": "near-weekly=3,intents-deep-dive=6",
    "OVERQUOTE_MILLI": "intents-deep-dive=9",
}
agent = {
    "PORT": "8788",
    "RPC_URL": dev["rpc_url"],
    "VAULT_ID": dev["vault_id"],
    "AGENT_ID": dev["agent_id"],
    "AGENT_KEYS": ",".join(dev["agent_keys"]),
    "MERCHANT_URLS": "http://localhost:8787,http://localhost:8789",
    "MERCHANT_ID": dev["merchant_id"],
    "ATTACKER_ID": dev["attacker_id"],
    "PLANNER": planner,
    "AGENT_API_TOKEN": api_token,
    "DEMO_ATTACKS": "1",
}
if genesis:
    agent["DEV_GENESIS"] = genesis


def write(name, values):
    path = ROOT / "target" / name
    path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    path.chmod(0o600)
    print(path)


web = {
    "VITE_NETWORK": network,
    "VITE_RPC_URL": dev["rpc_url"].rstrip("/"),
    "VITE_VAULT_ID": dev["vault_id"],
    "VITE_INTENTS_ID": dev["intents_id"],
    "VITE_AGENT_URL": "http://localhost:8788",
    "VITE_AGENT_TOKEN": api_token,
    "VITE_DEMO": "1",
}
if genesis:
    web |= {"VITE_DEV_GENESIS": genesis, "VITE_DEV_OWNER_ID": dev["owner_id"], "VITE_DEV_OWNER_KEY": dev["owner_key"]}

write("merchant.env", merchant)
write("merchant2.env", merchant2)
write("agent.env", agent)
web_env = ROOT / "app/web/.env.local"
web_env.write_text("".join(f"{k}={v}\n" for k, v in web.items()))
web_env.chmod(0o600)
print(web_env)
