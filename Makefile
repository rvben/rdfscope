.PHONY: frontend build test dev clean package release-check browser browser-check
PYTHON ?= python3
MATURIN ?= uvx --from maturin==1.14.1 maturin

frontend:
	cd web && npm ci && npm run build

build: frontend
	cargo build --release --locked

test:
	cd web && npm run format:check && npm run test && npm run build
	cargo fmt --check
	cargo clippy --locked --all-targets -- -D warnings
	cargo test --locked
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'
	$(PYTHON) scripts/release.py metadata

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
	wasm-pack build browser --target web --out-dir ../web/wasm --out-name rdfscope_browser --release -- --locked
	cd web && npm ci && npx tsc -b && npm run build:browser
	$(PYTHON) scripts/browser-notices.py
	cp browser/headers web/dist-browser/_headers
	cp LICENSE web/dist-browser/LICENSE.txt

browser-check:
	cargo fmt --manifest-path browser/Cargo.toml --check
	cargo test --manifest-path browser/Cargo.toml --locked
	cargo clippy --manifest-path browser/Cargo.toml --locked --all-targets -- -D warnings
