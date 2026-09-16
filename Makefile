.PHONY: frontend build test dev clean package release-check
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
