# RDFscope

A local RDF explorer. Open a file or connect to a SPARQL endpoint, follow connections, inspect the exact RDF terms, and save your investigation.

**[Try RDFscope in your browser →](https://rdfscope-demo.rvben.workers.dev/)** · [Quickstart with uv](#quickstart-with-uv)

Explore the sample or open your own RDF file. No installation; your data stays in your browser.

[![RDFscope browser edition showing The Semantic Web connected to its authors, publisher, and related concepts, with exact RDF properties in the inspector.](https://raw.githubusercontent.com/rvben/rdfscope/main/docs/images/rdfscope-demo.png)](https://rdfscope-demo.rvben.workers.dev/)

*A real exploration of the bundled sample. Click the screenshot to try it yourself.*

RDFscope is a Rust application with an embedded React interface and an in-process Oxigraph store. The built executable needs no Node.js, database server, Docker, or internet connection to explore local files.

**Status: early release (alpha maturity).** Version 0.1.0 is intended for developer
exploration and feedback. Features, APIs, and saved workspace formats may change
before 1.0. Keep your original RDF files; the store is disposable and in memory.
See [Data and operating limits](#data-and-operating-limits) before loading a dataset.

## Quickstart with uv

With [uv installed](https://docs.astral.sh/uv/getting-started/installation/), try the
bundled demo without a permanent install:

```sh
uvx rdfscope@0.1.0
```

This opens `http://127.0.0.1:7878` in your browser. Double-click a resource to follow
its connections, select it to inspect its RDF, or open the SPARQL editor to query
the dataset. No dataset download or database setup is needed.

To explore your own local RDF file, pass its path:

```sh
uvx rdfscope@0.1.0 data.ttl
```

Or connect to a SPARQL endpoint (replace the example URL with yours):

```sh
uvx rdfscope@0.1.0 --endpoint https://example.org/sparql
```

Press Ctrl+C in the terminal to stop the server. Each new process starts a fresh
session; save a workspace in the interface if you want to keep your investigation.
After the first download, cached local-file sessions can run offline with
`uvx --offline rdfscope@0.1.0 data.ttl`.

## Install

For regular use, install the standalone application from PyPI:

```sh
uv tool install rdfscope==0.1.0
# Or: pipx install rdfscope==0.1.0
rdfscope data.ttl
```

The Python package distributes the Rust executable, with no Python runtime
dependencies. Wheels target Linux (glibc 2.28+, x86-64 and ARM64), macOS (Intel
and Apple Silicon), and Windows (x86-64). The installer needs Python 3.10 or newer.

Or install through Cargo with Rust 1.98 or newer:

```sh
cargo install rdfscope --version 0.1.0 --locked
```

Registry source packages include the compiled interface, so Cargo installs and
Python source builds do not require Node.js. Python source builds require Rust
and a native C toolchain. Standalone archives with SHA-256 checksums are also
available on the [GitHub releases page](https://github.com/rvben/rdfscope/releases).

## Browser edition

[Open the browser demo](https://rdfscope-demo.rvben.workers.dev/) to explore the
bundled sample or your own files without installing anything or uploading data.
It runs the same Rust RDF engine through WebAssembly, hosted as a static app on
Cloudflare.
Browser files are limited to 10 MB; endpoint connections use the installed app.
Save a workspace before closing or reloading the tab.

See [Build, test, and deploy the browser demo](docs/browser-demo.md).

## VS Code extension

Download the VSIX from the [VS Code preview release](https://github.com/rvben/rdfscope/releases/tag/vscode-v0.1.0)
and use **Extensions → Install from VSIX**. Right-click a Turtle or RDF file to explore
it in VS Code, inspect terms, and run SPARQL. The text editor remains the default;
browsing does not modify your file.
See [build and usage instructions](vscode/README.md).

## Build and run

Development prerequisites: current stable Rust (tested with 1.98), Node.js 22.12 or newer, and npm.

```sh
make build
./target/release/rdfscope
```

The command opens `http://127.0.0.1:7878` with the bundled sample library. To use your data:

```sh
./target/release/rdfscope data.ttl
./target/release/rdfscope dataset.trig --port 8080
./target/release/rdfscope --endpoint https://example.org/sparql
./target/release/rdfscope --endpoint https://example.org/sparql --token-env SPARQL_TOKEN
./target/release/rdfscope --no-open --port 0
```

`--port 0` selects an available local port and prints the address. Endpoint credentials are read from the named environment variable; values are never printed. You can also enter a bearer token in the connection dialog.

Copy `target/release/rdfscope` to another machine with the same OS and CPU architecture to run it. All UI assets and sample data are embedded at compilation. Build separately for each target platform. Release builds are installed and smoke-tested on Linux x86-64 and ARM64, macOS Intel and Apple Silicon, and Windows x86-64.

## Explore

- **Open file:** Turtle, TriG, N-Triples, N-Quads, RDF/XML, and JSON-LD. Drop a file onto the application or use the file dialog. Failed imports leave the current dataset intact.
- **Find a resource:** search labels or full IRIs and narrow by RDF type. Endpoint mode searches the live dataset in pages of 25; switch to **Loaded data** for the cached sample. Enter a complete IRI to open it directly. The type catalog describes loaded data.
- **Follow connections:** double-click a node to add its first 25 connections. Use **Browse connections** in the inspector to page through a neighborhood, filter incoming/outgoing relationships and graph scope, and add selected pages to the canvas. Browsing continues independently of the canvas limit. Existing positions stay fixed; arrange, pin, focus, hide, or undo graph changes.
- **Inspect RDF:** endpoint resources fetch literal properties on selection, and connection pages hydrate labels and types. Literal values retain their language and datatype. Outgoing and incoming statements identify their named graph. Resource types are shown in the inspector rather than as `rdf:type` edges on the canvas.
- **Filter:** choose a relationship or named graph, or use the type filter. Filters apply to the resources currently on the canvas. Use SPARQL for full-dataset filtering.
- **Query:** SELECT, ASK, CONSTRUCT, and DESCRIBE run against the loaded store or connected endpoint. Example queries include named graphs explicitly. Result IRIs can be selected for inspection. Local SPARQL SERVICE requests and SPARQL Update are disabled.
- **Trace requests:** the **Trace** view shows generated SPARQL, timings, HTTP status, result counts, response sizes, and failures for the last 50 completed endpoint requests. Copy a query or open it in the SPARQL editor. Authentication headers and endpoint URL query parameters are excluded.
- **Save:** a `.rdfscope.json` workspace includes the loaded RDF, canvas, positions, pins, filters, labels, and query. Reopen it using **Open file**. Credentials are never included. Endpoint workspaces restore the cached sample as local data, and do not reconnect automatically.
- **Export:** SVG of the visible graph, N-Quads of the loaded dataset, or JSON query results.

Keyboard shortcuts: `/` finds a resource, `F` fits the graph, `⌘/Ctrl S` saves a workspace, and `⌘/Ctrl Enter` runs the current query.

## Data and operating limits

The store is in memory. Files are not modified, and application state ends when the process stops; save a workspace to retain your work. Multiple tabs connected to the same process share the active dataset, while their canvas arrangements are independent. Local files never leave the computer. Endpoint requests go to the endpoint you select. The interface itself uses no CDN, external fonts, accounts, or telemetry.

This first version intentionally bounds interactive work:

| Operation | Limit |
| --- | --- |
| RDF/workspace file import | 64 MB |
| Canvas | 200 resources, 2,000 edges |
| Connection / search page | 25 results in the UI; API accepts 1–50 |
| Relationship catalog | First 200 predicate/direction groups; all remain browsable |
| Inspector properties | 300 statements, with an explicit partial-results notice |
| Labels / types per fetch | 2,000 statements, with an explicit partial-results notice |
| Query display | 1,000 rows |
| Concurrent queries | 2 |
| Local query execution | 30 seconds, then cancellation |
| Endpoint request | 25 seconds, 8 MB response |
| Initial endpoint sample | 500 statements |
| Concurrent endpoint requests | 4; requests wait up to 5 seconds for a slot |
| Query trace | Last 50 completed requests, in memory |

The initial endpoint canvas is a cached sample, not a complete inventory. Sidebar counts describe loaded data; relationship counts and paginated connection searches query the endpoint directly. Connection pages show whether more results are available, without implying that the endpoint is fully loaded. Live data can change between pages; OFFSET pagination assumes a stable dataset. Label matching uses portable SPARQL substring searches, so large endpoints may need a more selective query. Local search is paginated; cached endpoint search considers the first 200 matches. Queries execute against the endpoint directly. Endpoint authentication supports bearer tokens; redirects are refused, so enter the final endpoint URL. Blank nodes are scoped to each endpoint response and cannot be reliably re-addressed across requests. JSON-LD files with embedded contexts are supported; automatic retrieval of remote contexts is not enabled. RDF 1.2/RDF-star and inferred reasoning are outside the current scope.

Relative IRIs in imported RDF use `https://rdfscope.local/import/` as their fallback base unless the document defines a base. Use absolute IRIs or an explicit base when document-relative identifiers matter.

## Development

```sh
cd web
npm ci
npm run build
cd ..
cargo run -- --no-open
```

For frontend hot reload, run `npm run dev` in `web/` while the Rust process is running. Vite proxies API requests to port 7878. Rebuild the frontend before building a distributable binary; the binary embeds the files currently in `web/dist/`.

```sh
make test
python3 scripts/smoke.py http://127.0.0.1:7878
```

The smoke test uses a local mock SPARQL server, replaces the running app's dataset with test data, then restores the bundled sample. Run it against a disposable process. The Rust endpoint integration test also starts a loopback-only SPARQL fixture backed by real Oxigraph queries. It checks large-neighborhood pagination, named-graph identity, label/type hydration, remote search, counts, metadata failures, and trace privacy. Tests cover RDF semantics and serialization, all supported formats, incoming connections, query limits/cancellation, read-only enforcement, local request guards, stable graph expansion, quad deduplication, and endpoint interaction.

For repeatable browser testing against a live local SPARQL fixture:

```sh
python3 scripts/endpoint_fixture.py
```

Connect to the printed URL using the printed seed IRI. The fixture contains 138 outgoing connections across two named graphs and labels outside the initial neighborhood sample. Stop it with Ctrl+C; its temporary data and child process are cleaned up.

Source layout:

- `src/main.rs`: CLI, local HTTP API, embedded assets, request guards.
- `src/lib.rs`: shared RDF engine used by the native CLI and browser adapter.
- `src/dataset.rs`: Oxigraph ingestion, indexes, graph projection, queries, serialization.
- `src/remote.rs`: endpoint discovery, bounded requests, metadata, and query trace.
- `src/exploration.rs`: shared search, property inspection, paginated connections, and exploration types.
- `browser/`: WebAssembly adapter; shares the root Cargo lockfile and builds without native dependencies.
- `web/src/`: React graph workspace, inspector, query editor, import flow.
- `examples/`: illustrative research library dataset.

Builds bind only to IPv4 loopback. Cross-origin requests and non-local Host headers are rejected. The API is intended for one local user, not shared hosting or direct public exposure.

## Releases and license

See [the release guide](docs/releases.md) for package checks, workflow dry runs,
registry setup, and recovery after a partial release.

RDFscope is licensed under [MIT](LICENSE). The embedded interface includes its
dependency notices at `/THIRD_PARTY_LICENSES.txt`.
