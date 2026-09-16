import { useEffect, useId, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { api, compact, short } from "./model";
import type { ConnectionPage, Graph, RelationGroups } from "./model";

export default function ConnectionBrowser({
  id,
  onSelect,
  onAdd,
  onLoaded,
}: {
  id: string;
  onSelect: (id: string) => void;
  onAdd: (graph: Graph) => void;
  onLoaded: (graph: Graph) => void;
}) {
  const [direction, setDirection] = useState("both"),
    [predicate, setPredicate] = useState(""),
    [graph, setGraph] = useState("");
  const [graphInput, setGraphInput] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const [offset, setOffset] = useState(0),
    [page, setPage] = useState<ConnectionPage | null>(null),
    [groups, setGroups] = useState<RelationGroups | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [groupError, setGroupError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPage(null);
    api<ConnectionPage>(
      "/neighborhood",
      { id, direction, predicate, graph, offset, limit: 25 },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setPage(value);
          onLoaded(value.graph);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, direction, predicate, graph, offset, retry, onLoaded]);
  useEffect(() => {
    const controller = new AbortController();
    setGroups(null);
    setGroupError("");
    api<RelationGroups>("/relations", { id, graph }, controller.signal)
      .then(setGroups)
      .catch((e) => {
        if (!controller.signal.aborted) setGroupError(e.message);
      });
    return () => controller.abort();
  }, [id, graph, retry]);
  const predicates = new Map<string, number>();
  for (const g of groups?.groups || [])
    if (direction === "both" || direction === g.direction)
      predicates.set(g.predicate, (predicates.get(g.predicate) || 0) + g.count);
  const label = (value: string) =>
    page?.graph.nodes.find((n) => n.id === value)?.label || short(value);
  return (
    <div
      className="connection-browser"
      role="tabpanel"
      aria-label="Connections"
    >
      <button
        className="connection-filter-toggle"
        aria-label="Filter connections"
        aria-expanded={filtersOpen}
        aria-controls={filterId}
        onClick={() => setFiltersOpen(!filtersOpen)}
      >
        <SlidersHorizontal size={14} />
        <strong>Filters</strong>
        <span>
          {direction === "both"
            ? "Both directions"
            : direction === "incoming"
              ? "Incoming"
              : "Outgoing"}{" "}
          · {graph ? short(graph) : "All graphs"}
          {predicate ? ` · ${short(predicate)}` : ""}
        </span>
        <ChevronDown size={13} />
      </button>
      <div
        id={filterId}
        className={`connection-filters ${filtersOpen ? "expanded" : ""}`}
      >
        <label>
          Direction
          <select
            value={direction}
            onChange={(e) => {
              setDirection(e.target.value);
              setPredicate("");
              setOffset(0);
            }}
          >
            <option value="both">Both directions</option>
            <option value="outgoing">Outgoing</option>
            <option value="incoming">Incoming</option>
          </select>
        </label>
        <label>
          Relationship
          <select
            value={predicate}
            onChange={(e) => {
              setPredicate(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All relationships</option>
            {[...predicates].map(([iri, count]) => (
              <option key={iri} value={iri}>
                {short(iri)} ({count})
              </option>
            ))}
          </select>
        </label>
        {groupError && (
          <p className="inline-error" role="alert">
            Counts unavailable. {groupError}{" "}
            <button
              className="text-button"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry
            </button>
          </p>
        )}
        {groups?.has_more && (
          <p className="limit-note">
            First 200 relationship groups shown. All relationships still
            includes every predicate.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const nextGraph = graphInput.trim();
            if (nextGraph !== graph) setPredicate("");
            setGraph(nextGraph);
            setOffset(0);
            setFiltersOpen(false);
          }}
        >
          <label>
            Graph scope
            <span className="graph-scope-input">
              <input
                aria-label="Connection graph scope"
                value={graphInput}
                onChange={(e) => setGraphInput(e.target.value)}
                placeholder="All graphs · or enter an IRI"
              />
              <button className="button" type="submit">
                Apply
              </button>
            </span>
          </label>
          <small>
            Leave empty for all graphs. Use “default” for the default graph.
          </small>
        </form>
      </div>
      {loading && (
        <p className="empty-note" role="status">
          Loading connections…
        </p>
      )}
      {error && (
        <div className="inline-error" role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => setRetry((n) => n + 1)}>
            <RefreshCw size={13} />
            Retry connections
          </button>
        </div>
      )}
      {page && (
        <>
          <div className="connection-page-heading">
            <span>
              {page.scope === "endpoint"
                ? "Live endpoint"
                : page.scope === "cache"
                  ? "Cached connections"
                  : "Loaded data"}
            </span>
            <span>
              {page.statements.length
                ? `${offset + 1}–${offset + page.statements.length}`
                : "0"}
              {page.total !== null
                ? ` of ${page.total}`
                : page.has_more
                  ? " · more available"
                  : " · end"}
            </span>
          </div>
          {page.scope === "cache" && (
            <p className="limit-note">
              Blank-node identifiers belong to one response. Only connections
              from that cached response are available.
            </p>
          )}
          {page.warnings.map((w) => (
            <p className="limit-note" key={w}>
              {w}
            </p>
          ))}
          {!!page.statements.length && (
            <button
              className="button primary add-page"
              onClick={() => onAdd(page.graph)}
            >
              <Plus size={14} />
              Add this page to graph
            </button>
          )}
          <div className="page-controls">
            <button
              className="button"
              disabled={!offset}
              onClick={() => setOffset((n) => Math.max(0, n - 25))}
            >
              <ChevronLeft size={14} />
              Previous
            </button>
            <button
              className="button"
              disabled={!page.has_more}
              onClick={() => setOffset(page.next_offset!)}
            >
              Next
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="connection-list">
            {page.statements.map((s, i) => {
              const outgoing = s.subject === id,
                neighbor = outgoing ? s.object.value : s.subject;
              return (
                <button
                  className="connection"
                  key={i}
                  onClick={() => onSelect(neighbor)}
                  title={neighbor}
                >
                  <small title={s.predicate}>
                    {outgoing ? (
                      <ArrowUpRight size={12} />
                    ) : (
                      <ArrowDownLeft size={12} />
                    )}{" "}
                    {compact(s.predicate)}
                  </small>
                  <span>
                    {label(neighbor)}
                    <ArrowUpRight size={13} />
                  </span>
                  <em title={s.graph}>
                    {s.graph === "default" ? "Default graph" : compact(s.graph)}
                  </em>
                </button>
              );
            })}
          </div>
          {!page.statements.length && (
            <p className="empty-note">
              No connections match this scope.
              {page.scope === "endpoint"
                ? " Try another direction, relationship, or graph."
                : ""}
            </p>
          )}

          {page.scope === "endpoint" && (
            <p className="limit-note">
              Live results can change between pages. Resource connections
              exclude literal properties and rdf:type.
            </p>
          )}
        </>
      )}
    </div>
  );
}
