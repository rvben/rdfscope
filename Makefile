.PHONY: build test dev clean
build:
	cd web && npm ci && npm run build
	cargo build --release --locked

test:
	cd web && npm run format:check && npm run test && npm run build
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings
	cargo test --locked

dev:
	cd web && npm run build
	cargo run -- --no-open

clean:
	cargo clean
