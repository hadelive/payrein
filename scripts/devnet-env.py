#!/usr/bin/env python3
"""Writes target/merchant.env and target/agent.env from target/devnet.json (sandbox-only keys).

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


write("merchant.env", merchant)
write("agent.env", agent)
