import { useCallback, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Expand,
  Focus,
  Pin,
  PinOff,
  X,
  Network,
} from "lucide-react";
import type { Detail, Graph } from "./model";
import { category, palette, compact, short } from "./model";
import ConnectionBrowser from "./ConnectionBrowser";
import { ResourceIcon } from "./GraphCanvas";
interface Props {
  detail: Detail | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onLoaded: (graph: Graph) => void;
  pinned: boolean;
  onSelect: (id: string) => void;
  onAddPage: (graph: Graph) => void;
  onFocus: () => void;
  onPin: () => void;
  onHide: () => void;
  onClose: () => void;
}
export default function Inspector({
  detail,
  loading,
  error,
  onRetry,
  onLoaded,
  pinned,
  onSelect,
  onAddPage,
  onFocus,
  onPin,
  onHide,
  onClose,
}: Props) {
  const [tab, setTab] = useState<"properties" | "connections">("properties");
  const [copied, setCopied] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pageLoaded = useCallback(
    (graph: Graph) => {
      onLoaded(graph);
      requestAnimationFrame(() =>
        tabsRef.current?.scrollIntoView({ block: "start" }),
      );
    },
    [onLoaded],
  );
  const showConnections = () => {
    setTab("connections");
    requestAnimationFrame(() =>
      tabsRef.current?.scrollIntoView({ block: "start" }),
    );
  };
  if (!detail)
    return (
      <aside className="inspector">
        <div className="panel-heading">
          <span>Resource inspector</span>
          <button
            className="icon-button mobile-only"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="inspector-empty">
          <Network size={32} strokeWidth={1.3} />
          <h2>
            {loading
              ? "Loading resource…"
              : error
                ? "Could not inspect this resource"
                : "Follow your curiosity"}
          </h2>
          <p>
            {error ||
              "Select a resource to inspect its properties and explore its connections."}
          </p>
          {error && (
            <button className="button" onClick={onRetry}>
              Retry inspection
            </button>
          )}
        </div>
      </aside>
    );
  const r = detail.resource,
    c = palette[category(r)];
  const properties = detail.outgoing.filter((s) => s.object.kind === "literal");
  return (
    <aside
      className={`inspector ${loading ? "loading" : ""}`}
      aria-label="Resource inspector"
    >
      <div className="panel-heading">
        <span title={r.id}>
          {tab === "connections" ? r.label : "Resource inspector"}
        </span>
        <button
          className="icon-button"
          aria-label="Close inspector"
          title="Close inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="inspector-scroll">
        <div className="resource-heading">
          <span
            className="large-resource-icon"
            style={{ color: c.color, background: c.bg }}
          >
            <ResourceIcon resource={r} size={24} />
          </span>
          <span
            className="type-tag"
            style={{ color: c.color, background: c.bg }}
          >
            {r.types.length ? short(r.types[0]) : "Resource"}
          </span>
          <h2>{r.label}</h2>
          <div className="iri-row">
            <code title={r.id}>{compact(r.id)}</code>
            <button
              className="icon-button"
              aria-label="Copy resource IRI"
              title="Copy resource IRI"
              onClick={() =>
                void navigator.clipboard.writeText(r.id).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                })
              }
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          {r.description && (
            <p className="resource-description">{r.description}</p>
          )}
          <div className="resource-actions">
            <button className="button primary" onClick={showConnections}>
              <Expand size={15} />
              Browse connections
            </button>
            <button
              className="icon-button bordered"
              title="Focus on this resource"
              aria-label="Focus on this resource"
              onClick={onFocus}
            >
              <Focus size={17} />
            </button>
          </div>
          <div className="subtle-actions">
            <button onClick={onPin}>
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}{" "}
              {pinned ? "Unpin position" : "Pin position"}
            </button>
            <button onClick={onHide}>
              <X size={13} />
              Hide from canvas
            </button>
          </div>
        </div>
        <div
          ref={tabsRef}
          className="inspector-tabs"
          role="tablist"
          aria-label="Resource details"
        >
          <button
            role="tab"
            aria-selected={tab === "properties"}
            className={tab === "properties" ? "active" : ""}
            onClick={() => setTab("properties")}
          >
            Properties <span>{properties.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "connections"}
            className={tab === "connections" ? "active" : ""}
            onClick={showConnections}
          >
            Connections
          </button>
        </div>
        {tab === "properties" ? (
          <div className="property-list" role="tabpanel">
            {detail.scope === "endpoint" && (
              <p className="limit-note">
                Properties fetched from the endpoint. Connections are browsed
                separately.
              </p>
            )}
            {detail.scope === "cache" && (
              <p className="limit-note">
                Blank-node details are limited to the cached response.
              </p>
            )}
            <div className="property">
              <dt>Type</dt>
              <dd className="type-list">
                {r.types.length
                  ? r.types.map((t) => (
                      <button key={t} title={t} onClick={() => onSelect(t)}>
                        {compact(t)}
                        <ArrowUpRight size={11} />
                      </button>
                    ))
                  : "No declared type"}
              </dd>
            </div>
            {properties.map((s, i) => (
              <div className="property" key={i}>
                <dt title={s.predicate}>{compact(s.predicate)}</dt>
                <dd>
                  {s.object.value}
                  <div className="value-meta">
                    {s.object.language && <span>@{s.object.language}</span>}
                    {s.object.datatype &&
                      !s.object.datatype.endsWith("#string") &&
                      !s.object.language && (
                        <span>{compact(s.object.datatype)}</span>
                      )}
                    <span title={s.graph}>
                      {s.graph === "default"
                        ? "Default graph"
                        : compact(s.graph)}
                    </span>
                  </div>
                </dd>
              </div>
            ))}
            {!properties.length && (
              <p className="empty-note">
                No literal properties in the loaded data.
              </p>
            )}
          </div>
        ) : (
          <ConnectionBrowser
            key={r.id}
            id={r.id}
            onSelect={onSelect}
            onAdd={onAddPage}
            onLoaded={pageLoaded}
          />
        )}
        {tab === "properties" &&
          (detail.properties_more || detail.outgoing_total > 300) && (
            <p className="limit-note">
              Showing up to 300 property statements. Use SPARQL to inspect more.
            </p>
          )}
      </div>
      <div className="inspector-footer">
        <span className="small-dot" />
        RDF terms preserved · Read only
      </div>
    </aside>
  );
}
