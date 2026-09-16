# Releases

RDFscope follows the Rust CLI release pattern used by clihatch and the other
projects: version tags, Maturin binary wheels, manual dry runs, native archives
with SHA-256 checksums, and independently retryable publishing jobs.

The first version is **0.1.0**, with alpha maturity stated in the README and Python
package classifier. It is a normal registry version, not a SemVer prerelease;
installers will not need `--pre`. The GitHub release is also a normal release.

## First-release setup

Before publishing:

1. Create the intended GitHub repository, `rvben/rdfscope`, and push the reviewed
   source to `main`. Keep required checks and contributor protections enabled.
2. Configure repository secrets `CARGO_REGISTRY_TOKEN` and `PYPI_API_TOKEN`, as in
   the clihatch release template. The initial tokens must be allowed to create
   `rdfscope` on their registries. Later PyPI tokens can be scoped to the project.
   Never put token values in files, workflow inputs, or command-line arguments.
3. Run the Release workflow from `main` with `dry_run: true`. This builds and
   validates all distributions but does not publish packages, create a release,
   or create a tag. Workflow artifacts remain available for inspection.
4. After reviewing the successful dry run and approving publication, push the
   `v0.1.0` tag pointing to the reviewed commit.

The local preparation does not create the repository, configure secrets, push
commits or tags, or publish anything. Those are separate authorized actions.

## Build and validate locally

Requirements: the pinned Rust toolchain, Node.js 22.12+, npm, Python 3.11+ for
release helpers, uv, and actionlint. End users installing wheels only need
Python 3.10+ for their installer; the executable itself is independent of Python.

```sh
make frontend
make test
make release-check
make package
uvx --from twine==6.2.0 twine check --strict dist/*.whl dist/rdfscope-[0-9]*.tar.gz
```

`make package` must start from committed source: the release helper checks Git's
working tree, including staged changes and untracked source files. Cargo then
uses `--allow-dirty` specifically because its package includes ignored generated
UI files. Source files must still be committed before packaging.
It builds the frontend first, verifies a crates.io source package, and produces
a native wheel and a Python source distribution. All version metadata derives
from `Cargo.toml`; the frontend manifest and lockfile must agree. Maturin converts
SemVer prereleases to the corresponding Python version if used in future.

Generated `web/dist/` files are ignored by Git but explicitly included in the
source distributions. Registry users compile Rust only. The package-content
check verifies every asset referenced by the HTML, frontend dependency notices,
and exclusion of private workspaces and design artifacts. `build.rs` gives a
clear error when someone builds a fresh Git checkout without the frontend.

To check an installed wheel:

```sh
uv venv .venv-wheel
uv pip install --python .venv-wheel/bin/python dist/*.whl
python3 scripts/release.py smoke .venv-wheel/bin/rdfscope
```

The smoke check starts a disposable process on an available loopback port from
a temporary working directory. It exercises the embedded UI, file import,
queries, endpoint interaction, and exports, then stops the process. It never
uses an existing RDFscope session. On Windows the executable is under
`.venv-wheel/Scripts/rdfscope.exe`.

## GitHub Actions

CI runs frontend tests, formatting and builds; Rust tests, formatting and Clippy;
release-helper tests and workflow linting; and an API smoke test against the
release binary. Release reuses that CI workflow, including its tested frontend.

The release matrix builds and smoke-tests a native wheel on each target:

| Target | Runner | Distribution |
| --- | --- | --- |
| Linux x86-64 | Ubuntu x86-64 | manylinux 2.28 wheel, tar.gz |
| Linux ARM64 | Ubuntu ARM64 | manylinux 2.28 wheel, tar.gz |
| macOS Intel | macOS Intel | wheel, tar.gz |
| macOS Apple Silicon | macOS ARM64 | wheel, tar.gz |
| Windows x86-64 | Windows x86-64 | wheel, zip |

Standalone archives contain the executable taken from the validated wheel,
README, changelog, MIT license, and frontend dependency notices. Each archive
has a companion `.sha256` file. Musl/Alpine and Windows ARM64 wheels are not
included in the initial matrix.

The source job verifies the Cargo package and installs the Python source
distribution in a fresh virtual environment. All package builds, smoke checks,
and strict Twine checks must succeed before any publishing job can run.
crates.io publishes from the validated source archive; PyPI uploads the validated
wheels and sdist. Both registries and the GitHub release have separate jobs.

The workflow accepts manual runs with `dry_run` enabled by default. A real
manual release must run against an existing tag matching the package version;
a branch cannot publish. Use `skip_crates_io` or `skip_pypi` when resuming a
partially completed release, or rerun only failed jobs at the original commit.
Do not change source contents under an already published version.

## Failure policy

If only a brief public tag exists and no release, artifact, package, checksum,
or attestation was published, delete and recreate the tag and retry the same
version. Once anything has been published, preserve the tag. Retry a failed
destination with the same validated contents, or issue a patch release when
release contents must change. GitHub assets are not overwritten on retries.
