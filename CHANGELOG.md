# Changelog

## [0.1.0]

First public release. RDFscope is early-stage software with alpha maturity;
interfaces and workspace compatibility may change before 1.0.

- Explore local Turtle, TriG, N-Triples, N-Quads, RDF/XML, and JSON-LD files in
  an embedded Oxigraph store and browser interface.
- Search and inspect RDF resources, labels, types, literal values, and named graphs.
- Browse paginated incoming and outgoing connections, filter relationships, and
  arrange, pin, hide, and expand nodes on the canvas.
- Connect to a SPARQL endpoint for live search and neighborhood exploration.
- Run SELECT, ASK, CONSTRUCT, and DESCRIBE queries, and inspect endpoint request traces.
- Save exploration workspaces and export SVG, N-Quads, and query results.
- Install the same standalone application through Cargo, Python binary wheels,
  or platform archives. Source packages include the compiled interface.

Known limits: storage is in memory, only one dataset or endpoint is active per
process, imports are capped at 64 MB, and the canvas shows at most 200 resources
and 2,000 edges. Dedicated path finding, reasoning, SHACL validation, and reliable
cross-request remote blank-node navigation are not provided. See the README for
the complete operating limits.
