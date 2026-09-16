# RDFscope

A local RDF explorer. Open a file or connect to a SPARQL endpoint, follow connections, inspect the exact RDF terms, and save your investigation.

RDFscope is a Rust application with an embedded React interface and an in-process Oxigraph store. The built executable needs no Node.js, database server, Docker, or internet connection to explore local files.

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

Copy `target/release/rdfscope` to another machine with the same OS and CPU architecture to run it. All UI assets and sample data are embedded at compilation. Build separately for each target platform; the current build was verified on macOS arm64.

## Explore

- **Open file:** Turtle, TriG, N-Triples, N-Quads, RDF/XML, and JSON-LD. Drop a file onto the application or use the file dialog. Failed imports leave the current dataset intact.
- **Find a resource:** search labels or full IRIs; narrow by RDF type. Search results are capped at 200 and the full dataset remains queryable.
- **Follow connections:** double-click a node or use **Expand connections**. Existing positions stay fixed. Drag nodes to arrange them, pin positions, focus on a neighborhood, hide nodes, or undo the last graph change.
- **Inspect RDF:** literal values retain their language and datatype. Outgoing and incoming statements identify their named graph. Resource types are shown in the inspector rather than as `rdf:type` edges on the canvas.
- **Filter:** choose a relationship or named graph, or use the type filter. Filters apply to the resources currently on the canvas. Use SPARQL for full-dataset filtering.
- **Query:** SELECT, ASK, CONSTRUCT, and DESCRIBE run against the loaded store or connected endpoint. Example queries include named graphs explicitly. Result IRIs can be selected for inspection. Local SPARQL SERVICE requests and SPARQL Update are disabled.
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
| One neighborhood expansion | 60 resources |
| Inspector | 300 statements per direction |
| Query display | 1,000 rows |
| Concurrent queries | 2 |
| Local query execution | 30 seconds, then cancellation |
| Endpoint request | 25 seconds, 8 MB response |
| Endpoint exploration fetch | 500 statements |

Endpoint exploration is a cached, bounded sample, not a complete inventory. Counts describe loaded data. Queries execute against the endpoint directly. Endpoint authentication supports bearer tokens; redirects are refused, so enter the final endpoint URL. Blank nodes are scoped to each endpoint response and cannot be reliably re-addressed across requests. JSON-LD files with embedded contexts are supported; automatic retrieval of remote contexts is not enabled. RDF 1.2/RDF-star and inferred reasoning are outside the current scope.

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

The smoke test uses a local mock SPARQL server, replaces the running app's dataset with test data, then restores the bundled sample. Run it against a disposable process. Tests cover RDF semantics and serialization, all supported formats, incoming connections, query limits/cancellation, read-only enforcement, local request guards, stable graph expansion, quad deduplication, and endpoint interaction.

Source layout:

- `src/main.rs`: CLI, local HTTP API, embedded assets, request guards.
- `src/dataset.rs`: Oxigraph ingestion, indexes, graph projection, queries, serialization.
- `src/remote.rs`: bounded SPARQL requests and response-scoped blank nodes.
- `web/src/`: React graph workspace, inspector, query editor, import flow.
- `examples/`: illustrative research library dataset.

Builds bind only to IPv4 loopback. Cross-origin requests and non-local Host headers are rejected. The API is intended for one local user, not shared hosting or direct public exposure.
