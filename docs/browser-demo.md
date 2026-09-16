# Browser demo on Cloudflare

The browser edition hosts static assets on Cloudflare Workers. Rust and Oxigraph
compile to WebAssembly and run in a dedicated Web Worker in each visitor's tab.
There is no hosted graph database, upload API, shared dataset, account, or runtime
backend. Local files stay in the browser. The deployed content security policy
allows network requests only to the site's own origin.

Both editions depend on the shared library in `src/lib.rs`. It owns parsing,
indexing, SPARQL, search pagination, property inspection, and graph traversal.
The browser adapter uses a normal Cargo dependency with default features disabled;
the `native` feature keeps the HTTP server, endpoint client, and CLI dependencies
out of the browser engine. The Cargo workspace shares one lockfile. The library
ships in the existing `rdfscope` package, with no separate core crate to publish.

The React interface selects a browser transport at build time; normal builds
retain the localhost HTTP transport. Browser assets have their own output
directory and are never embedded into the native executable. The browser build
uses its own optimized Cargo profile; the default build still targets the native
application. `make core-check` tests the engine without native features or UI
assets, and both CI workflows run it.

## What visitors can do

- Start immediately with the bundled illustrative library.
- Open RDF files and saved workspaces, inspect entities and named graphs, search,
  expand and browse neighborhoods, and use the same canvas tools.
- Run SELECT, ASK, CONSTRUCT, and DESCRIBE queries locally.
- Save a workspace or export N-Quads, SVG, and query results.

Browser imports are limited to **10 MB**; other exploration limits match the
installed app. Each tab has its own disposable in-memory dataset. Reloading or
closing the tab resets it; download a workspace to retain an investigation.
SPARQL endpoints and request traces are available in the installed app. This
edition does not run an endpoint proxy or ask visitors for credentials.

Queries run against an N-Quads snapshot in a separate worker, with one query at a
time. After 30 seconds the query worker is terminated without affecting the
active dataset. Snapshot creation and parsing add overhead and use additional
browser memory. Large datasets are better suited to the installed application.
An import or other engine operation that exceeds 60 seconds stops that browser
session and asks the visitor to reload with a smaller file.

## Build and preview

Use a Git checkout, Rust 1.98, Node.js 22.12+ with npm, and wasm-pack 0.14.0:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.14.0 --locked
make browser-check browser
cd web
npx wrangler dev --config ../wrangler.jsonc --ip 127.0.0.1 --port 4173 --local
```

Open `http://127.0.0.1:4173`. This serves the actual deployment assets and security
headers through Cloudflare's local runtime. `web/dist-browser` is disposable
build output; `web/wasm` contains generated bindings. Neither is committed.

To run the browser checks:

```sh
cd web
npx playwright install chromium --only-shell
npm run test:browser
```

Tests cover real WebAssembly initialization under the deployed CSP, file import,
RDF terms and named graphs, queries, invalid and oversized files, export and
workspace restore, no API/outbound requests, and query timeout recovery. The test
server starts automatically when port 4173 is free. On macOS, set
`HEADLESS_BROWSER_WRAPPER` to your safe headless browser wrapper and
`CHROME_FOR_TESTING_BIN` to a managed test-browser executable when required by
workspace policy. Optional `SCREENSHOT_DIR` captures desktop/mobile evidence.

## Deployment

`wrangler.jsonc` names the deployment `rdfscope-demo`. No bindings or paid storage
services are required. To validate without publishing:

```sh
npx --prefix web wrangler deploy --config wrangler.jsonc --dry-run
```

After approving publication and authenticating Wrangler, deploy the tested assets:

```sh
npx --prefix web wrangler deploy --config wrangler.jsonc
```

Cloudflare prints the resulting `workers.dev` URL. A custom domain can be attached
later. Static assets hosting is documented in the
[Cloudflare Workers guide](https://developers.cloudflare.com/workers/static-assets/).

The **Browser demo** GitHub workflow builds and checks every push/PR without
publishing. Its manual `deploy` input defaults to false. To enable approved manual
publication, configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository
secrets. Grant the token Workers Scripts edit access for the intended account.
Dispatch from `main` with `deploy: true`; it deploys only the artifact that passed
that run's checks. Native releases and registry versions remain independent.
