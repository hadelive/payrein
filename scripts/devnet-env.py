#!/usr/bin/env python3
"""Writes target/merchant.env, target/agent.env and app/web/.env.local from target/devnet.json
(sandbox-only keys; all three are git-ignored).

Usage: python3 -I scripts/devnet-env.py [scripted|nearai]
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
dev = json.loads((ROOT / "target/devnet.json").read_text())
planner = sys.argv[1] if len(sys.argv) > 1 else "scripted"

merchant = {
    "PORT": "8787",
    "RPC_URL": dev["rpc_url"],
    "MERCHANT_ID": dev["merchant_id"],
    "INTENTS_ID": dev["intents_id"],
    "VAULT_ID": dev["vault_id"],
    "TOKEN_ID": dev["token_id"],
    "DB_PATH": str(ROOT / "target/merchant.sqlite"),
    # Demo T1: the merchant tries to redirect payment to the attacker in its invoice text.
    "INJECT_RECIPIENT": dev["attacker_id"],
}
agent = {
    "PORT": "8788",
    "RPC_URL": dev["rpc_url"],
    "VAULT_ID": dev["vault_id"],
    "AGENT_ID": dev["agent_id"],
    "AGENT_KEYS": ",".join(dev["agent_keys"]),
    "MERCHANT_URL": "http://localhost:8787",
    "MERCHANT_ID": dev["merchant_id"],
    "ATTACKER_ID": dev["attacker_id"],
    "PLANNER": planner,
}


def write(name, values):
    path = ROOT / "target" / name
    path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    path.chmod(0o600)
    print(path)


web = {
    "VITE_NETWORK": "devnet",
    "VITE_RPC_URL": dev["rpc_url"].rstrip("/"),
    "VITE_VAULT_ID": dev["vault_id"],
    "VITE_INTENTS_ID": dev["intents_id"],
    "VITE_AGENT_URL": "http://localhost:8788",
    "VITE_DEMO": "1",
    "VITE_DEV_OWNER_ID": dev["owner_id"],
    "VITE_DEV_OWNER_KEY": dev["owner_key"],
}

write("merchant.env", merchant)
write("agent.env", agent)
web_env = ROOT / "app/web/.env.local"
web_env.write_text("".join(f"{k}={v}\n" for k, v in web.items()))
web_env.chmod(0o600)
print(web_env)
