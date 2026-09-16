import {
  Play,
  Download,
  Check,
  Terminal,
  ArrowUpRight,
  LoaderCircle,
} from "lucide-react";
import type { QueryResult, Term } from "./model";
import { compact, download, defaultQuery } from "./model";
const templates = [
  { label: "All statements", query: defaultQuery },
  {
    label: "Classes and counts",
    query:
      "SELECT ?type (COUNT(DISTINCT ?resource) AS ?count)\nWHERE {\n  { ?resource a ?type }\n  UNION { GRAPH ?g { ?resource a ?type } }\n}\nGROUP BY ?type\nORDER BY DESC(?count)",
  },
  {
    label: "Named graphs",
    query:
      "SELECT ?graph (COUNT(*) AS ?triples)\nWHERE { GRAPH ?graph { ?s ?p ?o } }\nGROUP BY ?graph\nORDER BY DESC(?triples)",
  },
];
export function TermCell({
  term,
  onSelect,
}: {
  term: Term | undefined;
  onSelect: (id: string) => void;
}) {
  if (!term) return <span className="unbound">—</span>;
  return term.kind === "literal" ? (
    <span className="literal-value" title={term.datatype}>
      {term.value}
      {term.language && <small>@{term.language}</small>}
    </span>
  ) : (
    <button
      className="term-link"
      title={term.value}
      onClick={() => onSelect(term.value)}
    >
      {compact(term.value)}
      <ArrowUpRight size={12} />
    </button>
  );
}
interface Props {
  query: string;
  onQuery: (q: string) => void;
  onRun: () => void;
  busy: boolean;
  result: QueryResult | null;
  error: string;
  onSelect: (id: string) => void;
  remote: boolean;
}
export default function QueryPanel({
  query,
  onQuery,
  onRun,
  busy,
  result,
  error,
  onSelect,
  remote,
}: Props) {
  return (
    <section className="query-panel" aria-label="SPARQL query workspace">
      <div className="query-heading">
        <div>
          <Terminal size={19} />
          <h2>Ask your graph</h2>
        </div>
        <span>
          {remote ? "Queries run on your endpoint" : "SPARQL · Local dataset"}
        </span>
      </div>
      <div className="query-examples">
        <span>Start with</span>
        {templates.map((t) => (
          <button key={t.label} onClick={() => onQuery(t.query)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="query-editor">
        <div className="line-numbers" aria-hidden="true">
          {query.split("\n").map((_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          aria-label="SPARQL query"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onRun();
            }
          }}
        />
      </div>
      <div className="query-actions">
        <span>
          Read-only queries <kbd>⌘ / Ctrl ↵</kbd>
        </span>
        <button
          className="button primary"
          disabled={busy || !query.trim()}
          onClick={onRun}
        >
          {busy ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Play size={14} />
          )}{" "}
          {busy ? "Running query…" : "Run query"}
        </button>
      </div>
      {error && (
        <div role="alert" className="query-error">
          <strong>Query could not run</strong>
          <p>{error}</p>
        </div>
      )}
      {!result && !error && (
        <div className="query-empty">
          <Terminal size={25} strokeWidth={1.3} />
          <h3>A question is a good place to start.</h3>
          <p>
            Run a query to inspect your data. Click a resource in the results to
            explore it.
          </p>
        </div>
      )}
      {result && (
        <div className="query-result">
          <div className="result-heading">
            <span>
              <Check size={14} />
              {result.kind === "boolean"
                ? "ASK result"
                : `${result.rows?.length.toLocaleString()} results`}
              {result.truncated ? " · first 1,000 rows" : ""}
              <small>{result.elapsed_ms.toLocaleString()} ms</small>
            </span>
            <button
              className="text-button"
              onClick={() =>
                download(
                  "rdfscope-query-results.json",
                  JSON.stringify(result, null, 2),
                )
              }
            >
              <Download size={14} />
              Export JSON
            </button>
          </div>
          {result.kind === "boolean" ? (
            <div className="boolean-result">
              {result.value ? "True" : "False"}
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {result.columns?.map((c) => (
                      <th key={c}>?{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows?.map((r, i) => (
                    <tr key={i}>
                      {result.columns?.map((c) => (
                        <td key={c}>
                          <TermCell term={r[c]} onSelect={onSelect} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.rows?.length && (
                <p className="empty-note">
                  No matches. Try a different pattern or include named graphs.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
