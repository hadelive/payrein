#!/usr/bin/env python3
"""Pin mainnet contract code for the sandbox tests (docs/acceptance.md, "Pinned contract code").

Fetches the code of intents.near and wrap.near at one final block with the RPC `view_code` query,
checks each against the account's on-chain code hash, and writes tests/fixtures/<name>.wasm plus
SOURCE.md. With --check it compares the existing fixtures with today's mainnet code hashes and
reports any difference without failing.
"""

import base64
import hashlib
import json
import pathlib
import sys
import urllib.request

RPC = "https://free.rpc.fastnear.com"
CONTRACTS = {"intents": "intents.near", "wrap": "wrap.near"}
FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": "fixtures", "method": method, "params": params})
    req = urllib.request.Request(RPC, body.encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if "error" in out:
        raise SystemExit(f"{method} failed: {out['error']}")
    return out["result"]


def b58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return s


def code_hash(account, block):
    return rpc("query", {"request_type": "view_account", "block_id": block, "account_id": account})["code_hash"]


def fetch():
    block = rpc("block", {"finality": "final"})["header"]["height"]
    lines = [
        "# Pinned contract code",
        "",
        "Written by `scripts/fetch-fixtures.py`. The sandbox tests check these checksums before running.",
        "",
        f"Mainnet block height: {block}",
        "",
        "| File | Account | SHA-256 (hex) | NEAR code hash (base58) |",
        "|---|---|---|---|",
    ]
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, account in CONTRACTS.items():
        res = rpc("query", {"request_type": "view_code", "block_id": block, "account_id": account})
        wasm = base64.b64decode(res["code_base64"])
        digest = hashlib.sha256(wasm).digest()
        expected = code_hash(account, block)
        if b58(digest) != expected:
            raise SystemExit(f"{account}: fetched code hashes to {b58(digest)}, chain says {expected}")
        (FIXTURES / f"{name}.wasm").write_bytes(wasm)
        lines.append(f"| `{name}.wasm` | `{account}` | `{digest.hex()}` | `{expected}` |")
        print(f"{account}: {len(wasm)} bytes, code hash {expected}")
    (FIXTURES / "SOURCE.md").write_text("\n".join(lines) + "\n")


def check():
    block = rpc("block", {"finality": "final"})["header"]["height"]
    for name, account in CONTRACTS.items():
        pinned = b58(hashlib.sha256((FIXTURES / f"{name}.wasm").read_bytes()).digest())
        live = code_hash(account, block)
        state = "same" if pinned == live else "DIFFERS (mainnet upgraded since the fixtures were pinned)"
        print(f"{account}: pinned {pinned}, live {live} at block {block}: {state}")


if __name__ == "__main__":
    check() if "--check" in sys.argv else fetch()
