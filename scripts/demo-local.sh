#!/usr/bin/env bash
# Runs the demo's services locally: the two merchants, the agent runner (scripted planner unless
# PLANNER=nearai) and the owner app on :5173. NETWORK=devnet (default) also starts a sandbox with
# the pinned Intents binary; NETWORK=testnet uses target/testnet.json from `make testnet`, and the
# owner signs in a testnet wallet. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

# Model settings come from an untracked .env at the repo root (see docs/setup-checklist.md); only
# these four keys are read, so the file never overrides what demo-env.py writes.
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in PLANNER|NEARAI_URL|NEARAI_API_KEY|NEARAI_MODEL) export "$k=$v" ;; esac
  done < .env
fi
PLANNER="${PLANNER:-scripted}"
NETWORK="${NETWORK:-devnet}"
for bin in demo/merchant/node_modules/.bin/tsx app/agent/node_modules/.bin/tsx app/web/node_modules/.bin/vite; do
  [ -x "$bin" ] || { echo "$bin is missing: run pnpm install first" >&2; exit 1; }
done
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

case "$NETWORK" in
  devnet)
    rm -f target/devnet.json target/merchant-devnet.sqlite target/merchant2-devnet.sqlite
    cargo run -q -p security-tests --example devnet &
    pids+=($!)
    for _ in $(seq 1 180); do [ -f target/devnet.json ] && break; sleep 1; done
    [ -f target/devnet.json ] || { echo "devnet did not start" >&2; exit 1; }
    ;;
  testnet)
    [ -f target/testnet.json ] || { echo "run TESTNET_ACCOUNT=<you>.testnet make testnet first" >&2; exit 1; }
    ;;
  *) echo "NETWORK must be devnet or testnet" >&2; exit 1 ;;
esac

python3 -I scripts/demo-env.py "$NETWORK" "$PLANNER" >/dev/null
(cd demo/merchant && exec node_modules/.bin/tsx --env-file=../../target/merchant.env src/server.ts) &
pids+=($!)
(cd demo/merchant && exec node_modules/.bin/tsx --env-file=../../target/merchant2.env src/server.ts) &
pids+=($!)
if [ "$PLANNER" = nearai ]; then
  : "${NEARAI_API_KEY:?set NEARAI_API_KEY}" "${NEARAI_MODEL:?set NEARAI_MODEL}"
fi
(cd app/agent && exec node_modules/.bin/tsx --env-file=../../target/agent.env src/server.ts) &
pids+=($!)
(cd app/web && exec node_modules/.bin/vite --host 127.0.0.1) &
pids+=($!)

echo "demo running on $NETWORK: open http://127.0.0.1:5173 (Ctrl-C to stop)"
# Any service exiting stops the demo with an error; bash 3.2 (macOS) has no `wait -n`.
while :; do
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || { echo "a demo service (pid $pid) exited; stopping" >&2; exit 1; }
  done
  sleep 1
done
