# RDFscope for VS Code (Preview)

Explore RDF files inside your editor: follow graph connections, inspect exact
IRIs and literal datatypes, search resources, and run read-only SPARQL queries.
The Rust RDF engine runs locally in a WebAssembly worker. No server, executable,
account, telemetry, or network connection is required to browse files.

Download the VSIX from the [preview release](https://github.com/rvben/rdfscope/releases/tag/vscode-v0.1.0)
and use **Extensions → Install from VSIX**. Marketplace publication uses the
pre-release channel under `rvben.rdfscope`. Preview releases may change as the
extension evolves.

## Use

- Right-click a `.ttl`, `.rdf`, `.trig`, `.nt`, `.nq`, or `.jsonld` file and choose
  **RDFscope: Explore RDF File**, or run that command from the Command Palette.
- Exploration opens in the current editor group. Use **Explore RDF File to the Side**
  when you want the graph and source in separate groups.
- Alternatively, choose **Reopen Editor With → RDFscope Graph Explorer**.
- Use **Open Source** in the editor toolbar to see the text beside the graph.
- Use **Reload from Source** to load edits, including unsaved text. Reload resets
  the exploration; save a workspace first to keep the layout and query.
- SPARQL uses the full pane, with **Run query** pinned above the editor.
  Inspect resources in a closable side drawer without leaving your query.
- Save a `.rdfscope.json` workspace and reopen it to restore an investigation.
  Workspace and graph/data/query exports use VS Code's Save dialog.

The text editor remains the default. Browsing never edits the RDF source.
Each graph tab has its own dataset and exploration. Hidden tabs retain their
state, but closing a tab ends the session; save a workspace before closing.

## Limits

Files are limited to 10 MB. The canvas shows at most 200 resources and 2,000
edges; use search, connection pages, and SPARQL to explore beyond it. Endpoint
connections are available in the standalone application, not the extension.
Remote JSON-LD contexts are not fetched. Relative IRIs use the existing engine's
`https://rdfscope.local/import/` fallback unless a document defines its own base.
This is a preview extension, using the same RDF engine as RDFscope.

## Build and try locally

Requires the repository's Rust/Node prerequisites and wasm-pack 0.14.0.
From the repository root:

```sh
npm --prefix vscode run build
npm --prefix vscode test
npm --prefix web exec -- playwright install chromium --only-shell
npm --prefix vscode run test:integration
code --extensionDevelopmentPath="$PWD/vscode" "$PWD"
```

If a verified browser build already exists locally, `npm --prefix vscode run build -- --reuse-engine`
rebuilds only the interface and reuses `web/wasm/` and its existing browser dependency notices.
Use the full build for releases.

In the development window, open `examples/research-library.trig` using RDFscope.
The build creates `vscode/media/` with the frontend, worker, WebAssembly engine,
and dependency notices. These generated files are not committed.

To create a local installable package after building:

```sh
cd vscode
npx @vscode/vsce package --no-dependencies --pre-release
```

Install the resulting `.vsix` through **Extensions → Install from VSIX**.
Packaging does not publish the extension. Marketplace publication requires a
publisher account and a separate release review.
