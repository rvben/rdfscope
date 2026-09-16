import { browserMode, fileLimitMb } from "#transport";
import { useEffect, useRef, useState } from "react";
import {
  X,
  Upload,
  Globe,
  FileCode2,
  ArrowRight,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
interface Props {
  open: boolean;
  initialTab: "file" | "endpoint";
  onClose: () => void;
  onFile: (f: File) => Promise<void>;
  onConnect: (url: string, token: string, seed: string) => Promise<void>;
  onSample: () => Promise<void>;
  busy: boolean;
}
export default function OpenDialog({
  open,
  initialTab,
  onClose,
  onFile,
  onConnect,
  onSample,
  busy,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState(initialTab),
    [url, setUrl] = useState(""),
    [token, setToken] = useState(""),
    [seed, setSeed] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setTab(browserMode ? "file" : initialTab);
      setError("");
      ref.current?.showModal();
    } else {
      ref.current?.close();
      setToken("");
    }
  }, [open, initialTab]);
  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <dialog
      ref={ref}
      className="open-dialog"
      aria-labelledby="open-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id="open-title">A new perspective on your data.</h2>
          <p>
            {browserMode
              ? "Open your own RDF file. It stays in this browser tab."
              : "Open a file, or explore a SPARQL endpoint."}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Close open dialog"
          disabled={busy}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </div>
      {!browserMode && (
        <div className="source-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "file"}
            className={tab === "file" ? "active" : ""}
            onClick={() => setTab("file")}
          >
            <FileCode2 size={16} />
            Local file
          </button>
          <button
            role="tab"
            aria-selected={tab === "endpoint"}
            className={tab === "endpoint" ? "active" : ""}
            onClick={() => setTab("endpoint")}
          >
            <Globe size={16} />
            SPARQL endpoint
          </button>
        </div>
      )}
      {tab === "file" ? (
        <div role="tabpanel">
          <button
            className="drop-target"
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const f = e.dataTransfer.files[0];
              if (f) void run(() => onFile(f));
            }}
          >
            <span className="upload-icon">
              {busy ? (
                <LoaderCircle size={26} className="spin" />
              ) : (
                <Upload size={26} strokeWidth={1.5} />
              )}
            </span>
            <strong>
              {busy ? "Reading your graph…" : "Drop an RDF file here"}
            </strong>
            <span>or click to browse your files</span>
            <small>
              Turtle · TriG · N-Triples · N-Quads · RDF/XML · JSON-LD
            </small>
            <small>
              Up to {fileLimitMb} MB · Saved .rdfscope.json workspaces also
              supported
            </small>
          </button>
          <input
            ref={input}
            type="file"
            hidden
            accept=".ttl,.trig,.nt,.nq,.rdf,.xml,.jsonld,.json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void run(() => onFile(f));
              e.target.value = "";
            }}
          />
          <p className="privacy-note">
            <LockKeyhole size={13} />
            {browserMode
              ? "Files are never uploaded. Save a workspace before closing or reloading this tab."
              : "Files are processed locally on this computer."}
          </p>
          {browserMode && (
            <p className="browser-install-note">
              Need larger files or SPARQL endpoints?{" "}
              <a
                href="https://github.com/rvben/rdfscope#install"
                target="_blank"
                rel="noreferrer"
              >
                Get the app
              </a>
              .
            </p>
          )}
        </div>
      ) : (
        <form
          role="tabpanel"
          className="endpoint-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => onConnect(url, token, seed));
          }}
        >
          <label>
            Endpoint URL
            <input
              autoFocus
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.org/sparql"
            />
          </label>
          <label>
            Start with a resource <span>optional</span>
            <input
              type="url"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="https://example.org/resource"
            />
          </label>
          <label>
            Bearer token <span>optional</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Kept in memory for this connection"
            />
          </label>
          <p className="form-note">
            Starts with up to 500 statements. Expanding a resource fetches its
            neighborhood. Queries are read only.
          </p>
          <button
            className="button primary connect-submit"
            type="submit"
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Globe size={15} />
            )}{" "}
            {busy ? "Connecting…" : "Connect to endpoint"}
            <ArrowRight size={15} />
          </button>
        </form>
      )}
      {error && (
        <div className="dialog-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <span>Just looking around?</span>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void run(onSample)}
        >
          Explore the sample library
          <ArrowRight size={14} />
        </button>
      </div>
    </dialog>
  );
}
