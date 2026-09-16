import { useState } from "react";
import {
  ArrowDownLeft,
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
import type { Detail, Resource } from "./model";
import { category, palette, compact, short } from "./model";
import { ResourceIcon } from "./GraphCanvas";
interface Props {
  detail: Detail | null;
  loading: boolean;
  pinned: boolean;
  onSelect: (id: string) => void;
  onExpand: () => void;
  onFocus: () => void;
  onPin: () => void;
  onHide: () => void;
  onClose: () => void;
  busy: boolean;
  resources: Resource[];
}
export default function Inspector({
  detail,
  loading,
  pinned,
  onSelect,
  onExpand,
  onFocus,
  onPin,
  onHide,
  onClose,
  busy,
  resources,
}: Props) {
  const [tab, setTab] = useState<"properties" | "connections">("properties");
  const [copied, setCopied] = useState(false);
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
          <h2>{loading ? "Loading resource…" : "Follow your curiosity"}</h2>
          <p>
            Select a resource to inspect its properties and explore its
            connections.
          </p>
        </div>
      </aside>
    );
  const r = detail.resource,
    c = palette[category(r)];
  const properties = detail.outgoing.filter((s) => s.object.kind === "literal");
  const outgoing = detail.outgoing.filter(
    (s) => s.object.kind !== "literal" && !s.predicate.endsWith("#type"),
  );
  const label = (id: string) =>
    resources.find((r) => r.id === id)?.label || short(id);
  return (
    <aside
      className={`inspector ${loading ? "loading" : ""}`}
      aria-label="Resource inspector"
    >
      <div className="panel-heading">
        <span>Resource inspector</span>
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
            <button
              className="button primary"
              onClick={onExpand}
              disabled={busy}
            >
              <Expand size={15} />
              {busy ? "Expanding…" : "Expand connections"}
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
            onClick={() => setTab("connections")}
          >
            Connections <span>{outgoing.length + detail.incoming.length}</span>
          </button>
        </div>
        {tab === "properties" ? (
          <div className="property-list" role="tabpanel">
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
          <div className="connection-list" role="tabpanel">
            <h3>
              <ArrowUpRight size={13} />
              Outgoing <span>{outgoing.length}</span>
            </h3>
            {outgoing.map((s, i) => (
              <button
                className="connection"
                key={`o${i}`}
                onClick={() => onSelect(s.object.value)}
              >
                <small title={s.predicate}>{compact(s.predicate)}</small>
                <span>
                  {label(s.object.value)}
                  <ArrowUpRight size={13} />
                </span>
                <em title={s.graph}>
                  {s.graph === "default" ? "Default graph" : compact(s.graph)}
                </em>
              </button>
            ))}
            <h3>
              <ArrowDownLeft size={13} />
              Incoming <span>{detail.incoming_total}</span>
            </h3>
            {detail.incoming.map((s, i) => (
              <button
                className="connection"
                key={`i${i}`}
                onClick={() => onSelect(s.subject)}
              >
                <small title={s.predicate}>{compact(s.predicate)}</small>
                <span>
                  {label(s.subject)}
                  <ArrowUpRight size={13} />
                </span>
                <em title={s.graph}>
                  {s.graph === "default" ? "Default graph" : compact(s.graph)}
                </em>
              </button>
            ))}
            {!outgoing.length && !detail.incoming.length && (
              <p className="empty-note">
                No resource connections in the loaded data.
              </p>
            )}
          </div>
        )}
        {(detail.outgoing_total > 300 || detail.incoming_total > 300) && (
          <p className="limit-note">
            Showing up to 300 statements per direction. Use SPARQL to inspect
            more.
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
