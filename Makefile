.PHONY: frontend build test core-check dev clean package release-check browser browser-check
PYTHON ?= python3
MATURIN ?= uvx --from maturin==1.14.1 maturin

frontend:
	cd web && npm ci && npm run build

build: frontend
	cargo build --release --locked

test: core-check
	cd web && npm run format:check && npm run test && npm run build
	cargo fmt --all --check
	cargo clippy --locked --all-targets -- -D warnings
	cargo test --locked
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'
	$(PYTHON) scripts/release.py metadata

# The library must also work without the native server and CLI features.
core-check:
	cargo test --locked --no-default-features --lib
	cargo clippy --locked --no-default-features --lib -- -D warnings

package:
	$(PYTHON) scripts/release.py metadata --clean
	$(MAKE) frontend
	cargo package --locked --allow-dirty
	$(MATURIN) build --release --locked --out dist
	$(MATURIN) sdist --out dist
	$(PYTHON) scripts/release.py check-artifacts 'target/package/*.crate' 'dist/*.whl' 'dist/rdfscope-[0-9]*.tar.gz'

release-check:
	$(PYTHON) scripts/release.py metadata
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'
	actionlint

dev:
	cd web && npm run build
	cargo run -- --no-open

clean:
	cargo clean

# A separate output keeps browser-only behavior out of the installed application.
browser:
	wasm-pack build browser --target web --out-dir ../web/wasm --out-name rdfscope_browser --profile browser --no-opt -- --locked
	cd web && npm ci && npx tsc -b && npm run build:browser
	$(PYTHON) scripts/browser-notices.py
	cp browser/headers web/dist-browser/_headers
	cp LICENSE web/dist-browser/LICENSE.txt

browser-check: core-check
	cargo fmt --all --check
	cargo test --manifest-path browser/Cargo.toml --locked
	cargo clippy --manifest-path browser/Cargo.toml --locked --all-targets -- -D warnings
