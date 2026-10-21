.PHONY: build build-test-gas test test-security check-live fixtures devnet

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
