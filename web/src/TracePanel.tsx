import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { api } from "./model";
interface Trace {
  id: number;
  started_at: number;
  purpose: string;
  endpoint: string;
  query: string;
  elapsed_ms: number;
  status: string;
  http_status: number | null;
  bytes: number;
  rows: number | null;
  error: string | null;
}
export default function TracePanel({
  remote,
  onQuery,
}: {
  remote: boolean;
  onQuery: (query: string) => void;
}) {
  const [rows, setRows] = useState<Trace[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    api<Trace[]>("/trace", undefined, controller.signal)
      .then(setRows)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [revision, remote]);
  return (
    <section className="trace-panel">
      <div className="table-heading">
        <h2>Query trace</h2>
        <div className="trace-actions">
          <button
            className="button"
            disabled={busy}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            className="icon-button"
            aria-label="Clear query trace"
            title="Clear query trace"
            disabled={!rows.length || busy}
            onClick={() => {
              void api("/trace/clear", {})
                .then(() => setRevision((n) => n + 1))
                .catch((e) => setError(e.message));
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      <p className="table-description">
        The last 50 completed endpoint requests, including queries generated
        while you explore. Kept in memory for this connection; authentication
        headers are excluded.
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="empty-note">
          Loading requests…
        </p>
      )}
      {!rows.length && !busy && (
        <div className="trace-empty">
          <Terminal size={28} />
          <h3>
            {remote
              ? "Your next request starts here"
              : "See how exploration becomes SPARQL"}
          </h3>
          <p>
            {remote
              ? "Search, browse a connection, or run a query, then refresh this trace."
              : "Connect a SPARQL endpoint to inspect generated queries, timings, result sizes, and errors."}
          </p>
        </div>
      )}
      {rows.map((row) => (
        <details className="trace-entry" key={row.id}>
          <summary>
            <span className={`trace-status ${row.status}`}>
              {row.status === "ok" ? "OK" : "Error"}
            </span>
            <strong>{row.purpose}</strong>
            <time dateTime={new Date(row.started_at).toISOString()}>
              {new Date(row.started_at).toLocaleTimeString()}
            </time>
            <span>{row.elapsed_ms.toLocaleString()} ms</span>
          </summary>
          <div className="trace-detail">
            <div className="trace-meta">
              <span>HTTP {row.http_status ?? "—"}</span>
              <span>
                {row.rows !== null ? `${row.rows} rows · ` : ""}
                {row.bytes.toLocaleString()} bytes
              </span>
            </div>
            <code className="trace-endpoint">{row.endpoint}</code>
            {row.error && <p className="inline-error">{row.error}</p>}
            <pre>{row.query}</pre>
            <div className="trace-actions">
              <button
                className="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(row.query)
                    .then(() => setCopied(row.id))
                    .catch(() =>
                      setError(
                        "Could not copy. Select the query text to copy it manually.",
                      ),
                    );
                }}
              >
                {copied === row.id ? <Check size={14} /> : <Copy size={14} />}
                Copy query
              </button>
              <button className="button" onClick={() => onQuery(row.query)}>
                <Terminal size={14} />
                Open in SPARQL
              </button>
            </div>
          </div>
        </details>
      ))}
    </section>
  );
}
