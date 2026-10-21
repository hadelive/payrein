#!/usr/bin/env bash
# Runs the whole demo locally: sandbox devnet with the pinned Intents binary, the merchant, the
# agent runner (scripted planner unless PLANNER=nearai) and the owner app on :5173.
# Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")/.."

PLANNER="${PLANNER:-scripted}"
rm -f target/devnet.json target/merchant.sqlite
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

cargo run -q -p security-tests --example devnet &
pids+=($!)
for _ in $(seq 1 180); do [ -f target/devnet.json ] && break; sleep 1; done
[ -f target/devnet.json ] || { echo "devnet did not start" >&2; exit 1; }

python3 -I scripts/devnet-env.py "$PLANNER" >/dev/null
(cd demo/merchant && exec node_modules/.bin/tsx --env-file=../../target/merchant.env src/server.ts) &
pids+=($!)
if [ "$PLANNER" = nearai ]; then
  : "${NEARAI_API_KEY:?set NEARAI_API_KEY}" "${NEARAI_MODEL:?set NEARAI_MODEL}"
fi
(cd app/agent && exec node_modules/.bin/tsx --env-file=../../target/agent.env src/server.ts) &
pids+=($!)
(cd app/web && exec node_modules/.bin/vite --host 127.0.0.1) &
pids+=($!)

echo "demo running: open http://127.0.0.1:5173 (Ctrl-C to stop)"
wait
