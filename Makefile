.PHONY: build build-test-gas test test-security check-live fixtures devnet demo-local testnet demo-testnet

build:
	cargo near build non-reproducible-wasm --manifest-path contracts/policy-vault/Cargo.toml

# t17b's starved-callback build, kept out of target/near so it can never be mistaken for a release.
build-test-gas:
	cargo near build non-reproducible-wasm --manifest-path contracts/policy-vault/Cargo.toml \
		--features test-gas --out-dir target/near-test-gas/policy_vault

test:
	cargo test -p policy-vault

test-security: build build-test-gas
	cargo test -p security-tests -- --test-threads 4

check-live:
	python3 -I scripts/fetch-fixtures.py --check

fixtures:
	python3 -I scripts/fetch-fixtures.py

# Local sandbox with the demo policy; writes target/devnet.json. Ctrl-C to stop.
devnet: build
	cargo run -p security-tests --example devnet

# The whole demo locally (devnet, merchant, agent runner, owner app on :5173). Ctrl-C to stop.
demo-local: build
	./scripts/demo-local.sh

# Testnet deployment under TESTNET_ACCOUNT (funded, key in ~/.near-credentials/testnet/); writes
# target/testnet.json. Spends ~18.6 testnet NEAR, most of it Intents' code storage.
testnet: build
	cargo run -p security-tests --example testnet

# The demo's services against that testnet deployment; the owner approves in a testnet wallet.
demo-testnet:
	NETWORK=testnet ./scripts/demo-local.sh
