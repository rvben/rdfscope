import { browserMode, fileLimitMb } from "#transport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Network,
  Activity,
  ChevronLeft,
  Search,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Globe,
  Download,
  Share2,
  Table2,
  Terminal,
  Plus,
  X,
  SlidersHorizontal,
  Tag,
  Undo2,
  FileCode2,
  ArrowUpRight,
  Check,
  AlertCircle,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Command,
  CircleHelp,
} from "lucide-react";
import type {
  Detail,
  ConnectionPage,
  SearchPage,
  Graph,
  Position,
  QueryResult,
  Resource,
  Summary,
} from "./model";
import {
  api,
  category,
  compact,
  defaultQuery,
  download,
  exportDataset,
  layout,
  mergeGraph,
  palette,
  short,
} from "./model";
import GraphCanvas, { ResourceIcon } from "./GraphCanvas";
import Inspector from "./Inspector";
import QueryPanel from "./QueryPanel";
import OpenDialog from "./OpenDialog";
import TracePanel from "./TracePanel";

const emptyGraph: Graph = { nodes: [], edges: [], total: 0, truncated: false };
type View = "graph" | "table" | "query" | "trace";
type Snapshot = {
  graph: Graph;
  positions: Record<string, Position>;
  selected: string | null;
};
type Workspace = {
  version: 1;
  name: string;
  nquads: string;
  graph: Graph;
  positions: Record<string, Position>;
  pinned: string[];
  selected: string | null;
  query: string;
  labels: boolean;
  filters?: { class: string; predicate: string; graph: string };
  minimap?: boolean;
};

function validateWorkspace(value: unknown): Workspace {
  const w = value as Workspace;
  if (
    !w ||
    w.version !== 1 ||
    typeof w.name !== "string" ||
    typeof w.nquads !== "string" ||
    !w.graph ||
    !Array.isArray(w.graph.nodes) ||
    !Array.isArray(w.graph.edges) ||
    w.graph.nodes.length > 200 ||
    w.graph.edges.length > 2000 ||
    !w.positions ||
    !Array.isArray(w.pinned) ||
    typeof w.query !== "string" ||
    typeof w.labels !== "boolean"
  )
    throw new Error(
      "This is not a supported RDFscope workspace. Open a version 1 .rdfscope.json file.",
    );
  for (const n of w.graph.nodes)
    if (
      typeof n.id !== "string" ||
      typeof n.label !== "string" ||
      !Array.isArray(n.types) ||
      !n.types.every((t) => typeof t === "string") ||
      typeof n.degree !== "number"
    )
      throw new Error("Workspace contains an invalid resource.");
  for (const e of w.graph.edges)
    if (
      !["source", "target", "predicate", "graph", "label", "id"].every(
        (k) => typeof e[k as keyof typeof e] === "string",
      )
    )
      throw new Error("Workspace contains an invalid connection.");
  for (const p of Object.values(w.positions))
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      throw new Error("Workspace contains an invalid node position.");
  if (
    w.filters &&
    !["class", "predicate", "graph"].every(
      (k) => typeof w.filters?.[k as keyof typeof w.filters] === "string",
    )
  )
    throw new Error("Workspace contains invalid filters.");
  if (
    !w.pinned.every((id) => typeof id === "string") ||
    (w.selected !== null && typeof w.selected !== "string")
  )
    throw new Error("Workspace contains an invalid selection.");
  return w;
}

export default function App() {
  const [summary, setSummary] = useState<Summary | null>(null),
    [graph, setGraph] = useState<Graph>(emptyGraph),
    [positions, setPositions] = useState<Record<string, Position>>({}),
    [resources, setResources] = useState<Resource[]>([]);
  const [detailError, setDetailError] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState(""),
    [classFilter, setClassFilter] = useState(""),
    [predicate, setPredicate] = useState(""),
    [namedGraph, setNamedGraph] = useState("");
  const [view, setView] = useState<View>("graph"),
    [labels, setLabels] = useState(false),
    [minimap, setMinimap] = useState(false),
    [pinned, setPinned] = useState<Set<string>>(new Set()),
    [fitKey, setFitKey] = useState(0);
  const [open, setOpen] = useState(false),
    [openTab, setOpenTab] = useState<"file" | "endpoint">("file"),
    [busy, setBusy] = useState(false),
    [expanding, setExpanding] = useState(false),
    [initial, setInitial] = useState(true);
  const [query, setQuery] = useState(defaultQuery),
    [queryResult, setQueryResult] = useState<QueryResult | null>(null),
    [queryBusy, setQueryBusy] = useState(false),
    [queryError, setQueryError] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
      null,
    ),
    [sidebar, setSidebar] = useState(false),
    [inspector, setInspector] = useState(true),
    [filters, setFilters] = useState(false),
    [showClasses, setShowClasses] = useState(true),
    [history, setHistory] = useState<Snapshot[]>([]),
    [help, setHelp] = useState(false),
    [dragging, setDragging] = useState(false);
  const [searchScope, setSearchScope] = useState("loaded"),
    [searchOffset, setSearchOffset] = useState(0),
    [searchMore, setSearchMore] = useState(false),
    [searchLoading, setSearchLoading] = useState(false),
    [searchError, setSearchError] = useState(""),
    [searchRetry, setSearchRetry] = useState(0);
  const epoch = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null),
    detailRequest = useRef(0),
    queryRequest = useRef(0),
    fileRef = useRef<HTMLInputElement>(null),
    dragDepth = useRef(0),
    noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    flow = useReactFlow();
  const notify = useCallback((text: string, error = false) => {
    setNotice({ text, error });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(
      () => setNotice(null),
      error ? 9000 : 4000,
    );
  }, []);
  const fail = (e: unknown) => notify((e as Error).message, true);
  const select = useCallback(
    async (id: string, reveal = true) => {
      const request = ++detailRequest.current;
      setSelected(id);
      setInspector(reveal);
      setDetailLoading(true);
      setDetailError("");
      setDetail(null);
      try {
        const value = await api<Detail>("/inspect", { id });
        if (request === detailRequest.current) {
          setDetail(value);
          setGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => (n.id === id ? value.resource : n)),
          }));
        }
        return request === detailRequest.current ? value : null;
      } catch (e) {
        if (request === detailRequest.current)
          setDetailError((e as Error).message);
      } finally {
        if (request === detailRequest.current) setDetailLoading(false);
      }
    },
    [notify],
  );
  const refreshSummary = useCallback(
    (hydrated: Graph) => {
      const metadata = new Map(hydrated.nodes.map((n) => [n.id, n]));
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => metadata.get(n.id) || n),
      }));
      void api<Summary>("/summary")
        .then(setSummary)
        .catch((e) => notify(e.message, true));
    },
    [notify],
  );
  const reset = useCallback(async () => {
    epoch.current++;
    detailRequest.current++;
    const s = await api<Summary>("/summary");
    setSearchScope(s.source === "endpoint" ? "endpoint" : "loaded");
    setSearchOffset(0);
    const g = await api<Graph>(
      s.source === "sample"
        ? "/graph?center=https%3A%2F%2Fexample.org%2Fknowledge-graphs&limit=20"
        : s.source === "endpoint"
          ? "/graph?limit=12"
          : "/graph?limit=26",
    );
    setSummary(s);
    setGraph(g);
    setPositions(layout(g));
    setPinned(new Set());
    setHistory([]);
    setSearch("");
    setClassFilter("");
    setPredicate("");
    setNamedGraph("");
    setQueryResult(null);
    setQueryError("");
    queryRequest.current++;
    setView("graph");
    setFitKey((k) => k + 1);
    const first =
      g.nodes.find((n) => n.id === "https://example.org/knowledge-graphs") ||
      [...g.nodes].sort((a, b) => b.degree - a.degree)[0];
    if (first)
      void select(first.id, !window.matchMedia("(max-width:980px)").matches);
    else {
      setSelected(null);
      setDetail(null);
    }
  }, [select]);
  useEffect(() => {
    void reset()
      .catch((e) => notify(e.message, true))
      .finally(() => setInitial(false));
  }, [reset, notify]);
  useEffect(() => {
    setSearchOffset(0);
  }, [search, classFilter, searchScope]);
  useEffect(() => {
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError("");
    setResources([]);
    setSearchMore(false);
    const timer = setTimeout(
      () => {
        const remote =
          summary?.source === "endpoint" && searchScope === "endpoint";
        const task =
          remote || summary?.source !== "endpoint"
            ? api<SearchPage>(
                "/search",
                {
                  q: search,
                  class: classFilter,
                  offset: searchOffset,
                  limit: 25,
                },
                controller.signal,
              )
            : api<Resource[]>(
                "/resources?q=" +
                  encodeURIComponent(search) +
                  "&class=" +
                  encodeURIComponent(classFilter),
                undefined,
                controller.signal,
              ).then((items) => ({
                items: items.slice(searchOffset, searchOffset + 25),
                has_more: items.length > searchOffset + 25,
                warnings:
                  items.length === 200
                    ? [
                        "Loaded search is limited to the first 200 matches. Narrow your search.",
                      ]
                    : [],
              }));
        void task
          .then((page) => {
            if (controller.signal.aborted) return;
            setResources(page.items);
            setSearchMore(page.has_more);
            if (page.warnings.length) setSearchError(page.warnings.join(" "));
          })
          .catch((e) => {
            if (!controller.signal.aborted) setSearchError(e.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setSearchLoading(false);
          });
      },
      search ? 300 : 0,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    search,
    classFilter,
    searchScope,
    searchOffset,
    summary?.source,
    summary?.name,
    searchScope === "loaded" ? summary?.triples : undefined,
    searchRetry,
  ]);
  const checkpoint = () =>
    setHistory((h) => [...h.slice(-19), { graph, positions, selected }]);
  const undo = () => {
    const prior = history.at(-1);
    if (!prior) return;
    setHistory((h) => h.slice(0, -1));
    setGraph(prior.graph);
    setPositions(prior.positions);
    if (prior.selected) void select(prior.selected);
    else {
      setSelected(null);
      setDetail(null);
    }
    setFitKey((k) => k + 1);
  };
  const addPage = (added: Graph) => {
    checkpoint();
    const next = mergeGraph(graph, added);
    setGraph(next);
    setPositions(
      layout(next, positions, selected ? positions[selected] : undefined),
    );
    setView("graph");
    const omitted =
      added.nodes.some((n) => !next.nodes.some((kept) => kept.id === n.id)) ||
      next.edges.length <
        new Set(
          [...graph.edges, ...added.edges].map((e) =>
            JSON.stringify([e.source, e.predicate, e.target, e.graph]),
          ),
        ).size;
    notify(
      omitted
        ? "Canvas limit reached (200 resources / 2,000 connections). Focus a resource to make room; browsing stays available."
        : `${Math.max(0, next.nodes.length - graph.nodes.length)} resources added · existing positions kept`,
    );
    void api<Summary>("/summary").then(setSummary).catch(fail);
  };
  const expand = async (id: string) => {
    if (expanding || busy) return;
    const currentEpoch = epoch.current;
    setExpanding(true);
    try {
      const page = await api<ConnectionPage>("/neighborhood", {
        id,
        limit: 25,
      });
      if (currentEpoch !== epoch.current) return;
      addPage(page.graph);
      void select(id);
      if (page.has_more)
        notify(
          "First 25 connections added. Browse connections in the inspector for more pages and filters.",
        );
      if (page.warnings.length) notify(page.warnings.join(" "), true);
    } catch (e) {
      if (currentEpoch === epoch.current) fail(e);
    } finally {
      setExpanding(false);
    }
  };
  const focus = async (id: string) => {
    try {
      const next = await api<Graph>(
        "/graph?center=" + encodeURIComponent(id) + "&limit=35",
      );
      checkpoint();
      setGraph(next);
      setPositions(layout(next));
      setClassFilter("");
      setPredicate("");
      setNamedGraph("");
      setView("graph");
      setFitKey((k) => k + 1);
      void select(id);
    } catch (e) {
      fail(e);
    }
  };
  const explore = async (id: string) => {
    const d = await select(id);
    if (!d) return;
    if (!graph.nodes.some((n) => n.id === id)) {
      if (graph.nodes.length >= 200)
        notify(
          "Canvas is full. The resource is open in the inspector; focus it to start a new neighborhood.",
        );
      else {
        checkpoint();
        const next = mergeGraph(graph, {
          nodes: [d.resource],
          edges: [],
          total: 1,
          truncated: false,
        });
        setGraph(next);
        setPositions(layout(next, positions));
      }
    }
    setSidebar(false);
  };
  const runQuery = async () => {
    if (queryBusy) return;
    const request = ++queryRequest.current;
    setQueryBusy(true);
    setQueryError("");
    setQueryResult(null);
    try {
      const result = await api<QueryResult>("/query", { query });
      if (request === queryRequest.current) setQueryResult(result);
    } catch (e) {
      if (request === queryRequest.current) setQueryError((e as Error).message);
    } finally {
      setQueryBusy(false);
    }
  };
  const importFile = async (file: File) => {
    if (file.size > fileLimitMb * 1024 * 1024)
      throw new Error(
        `Files up to ${fileLimitMb} MB are supported. ${browserMode ? "Use the installed app for larger datasets." : "Split larger datasets or connect to a SPARQL endpoint."}`,
      );
    setBusy(true);
    try {
      let workspace: Workspace | undefined;
      // Accept workspaces saved under the original prototype name.
      if (
        file.name.endsWith(".rdfscope.json") ||
        file.name.endsWith(".lattice.json")
      )
        workspace = validateWorkspace(JSON.parse(await file.text()));
      const form = new FormData();
      form.append(
        "file",
        workspace
          ? new File(
              [workspace.nquads],
              workspace.name.replace(/\.[^.]+$/, "") + ".nq",
              { type: "application/n-quads" },
            )
          : file,
      );
      await api("/import", form);
      await reset();
      if (workspace) {
        setSummary((s) => (s ? { ...s, name: workspace.name } : s));
        setGraph(workspace.graph);
        setPositions(workspace.positions);
        setPinned(new Set(workspace.pinned));
        setQuery(workspace.query);
        setLabels(workspace.labels);
        setMinimap(workspace.minimap === true);
        setClassFilter(workspace.filters?.class || "");
        setPredicate(workspace.filters?.predicate || "");
        setNamedGraph(workspace.filters?.graph || "");
        if (workspace.selected) void select(workspace.selected);
        setFitKey((k) => k + 1);
      }
      notify(
        workspace
          ? "Workspace restored. Data, positions, and query are ready."
          : `Opened ${file.name}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const connect = async (url: string, token: string, seed: string) => {
    setBusy(true);
    try {
      await api("/connect", { url, token, seed });
      await reset();
      notify(
        "Connected. Search the endpoint or browse a resource’s connections to fetch more.",
      );
    } finally {
      setBusy(false);
    }
  };
  const loadSample = async () => {
    setBusy(true);
    try {
      await api("/sample", {});
      await reset();
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    try {
      const nquads = await exportDataset();
      const saved: Workspace = {
        version: 1,
        name: summary?.name || "Workspace",
        nquads,
        graph,
        positions,
        pinned: [...pinned],
        selected,
        query,
        labels,
        filters: { class: classFilter, predicate, graph: namedGraph },
        minimap,
      };
      download("workspace.rdfscope.json", JSON.stringify(saved));
      notify("Workspace saved with its data, layout, and query.");
    } catch (e) {
      fail(e);
    }
  };
  const filtered = useMemo(() => {
    let nodes = graph.nodes.filter(
      (n) => !classFilter || n.types.includes(classFilter),
    );
    let ids = new Set(nodes.map((n) => n.id));
    let edges = graph.edges.filter(
      (e) =>
        ids.has(e.source) &&
        ids.has(e.target) &&
        (!predicate || e.predicate === predicate) &&
        (!namedGraph || e.graph === namedGraph),
    );
    if (predicate || namedGraph) {
      ids = new Set(edges.flatMap((e) => [e.source, e.target]));
      nodes = nodes.filter((n) => ids.has(n.id));
    }
    return { ...graph, nodes, edges };
  }, [graph, classFilter, predicate, namedGraph]);
  const exportSvg = () => {
    if (!filtered.nodes.length) return;
    const esc = (v: string) =>
      v.replace(
        /[<>&"']/g,
        (c) =>
          ({
            "<": "&lt;",
            ">": "&gt;",
            "&": "&amp;",
            '"': "&quot;",
            "'": "&apos;",
          })[c]!,
      );
    const xs = filtered.nodes.map((n) => positions[n.id]?.x || 0),
      ys = filtered.nodes.map((n) => positions[n.id]?.y || 0);
    const minX = Math.min(...xs) - 60,
      minY = Math.min(...ys) - 60,
      w = Math.max(...xs) - minX + 270,
      h = Math.max(...ys) - minY + 130;
    const edges = filtered.edges
      .map((e) => {
        const a = positions[e.source],
          b = positions[e.target];
        if (!a || !b) return "";
        return `<path d="M${a.x + 190} ${a.y + 31} C${a.x + 240} ${a.y + 31},${b.x - 50} ${b.y + 31},${b.x} ${b.y + 31}" fill="none" stroke="#9eafa7" marker-end="url(#arrow)"/>${labels ? `<text x="${(a.x + b.x) / 2 + 95}" y="${(a.y + b.y) / 2 + 24}" font-size="10" fill="#53645c">${esc(e.label)}</text>` : ""}`;
      })
      .join("");
    const nodes = filtered.nodes
      .map((n) => {
        const p = positions[n.id] || { x: 0, y: 0 },
          c = palette[category(n)];
        return `<g transform="translate(${p.x} ${p.y})"><rect width="190" height="62" rx="8" fill="white" stroke="#d1dcd6"/><circle cx="20" cy="24" r="5" fill="${c.color}"/><text x="34" y="27" font-size="12" fill="#233d31">${esc(n.label.length > 23 ? n.label.slice(0, 22) + "…" : n.label)}</text><text x="34" y="44" font-size="10" fill="#65746b">${esc(n.types.length ? short(n.types[0]) : "Resource")}</text><title>${esc(n.id)}</title></g>`;
      })
      .join("");
    download(
      "rdfscope-graph.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="${w}" height="${h}" font-family="system-ui,sans-serif"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#9eafa7"/></marker></defs><rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#f8faf9"/>${edges}${nodes}</svg>`,
      "image/svg+xml",
    );
    notify("Graph exported as SVG.");
  };
  const openSource = (tab: "file" | "endpoint") => {
    setOpenTab(tab);
    setOpen(true);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSidebar(false);
        setHelp(false);
      }
      const editing = (e.target as HTMLElement).closest(
        "input,textarea,select,[contenteditable],dialog[open]",
      );
      if (editing) return;
      if (e.key === "/") {
        e.preventDefault();
        setSidebar(true);
        searchRef.current?.focus();
      }
      if (e.key.toLowerCase() === "f")
        void flow.fitView({ padding: 0.2, duration: 250 });
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const resetFilters = () => {
    setClassFilter("");
    setPredicate("");
    setNamedGraph("");
  };
  const hiddenFilters = !!(classFilter || predicate || namedGraph);
  return (
    <div
      className={`app ${inspector ? "with-inspector" : ""} ${sidebar ? "sidebar-open" : ""}`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file && !busy) void importFile(file).catch(fail);
      }}
    >
      <aside className="sidebar" aria-label="Dataset browser">
        <a className="brand" href="/" aria-label="RDFscope home">
          <span className="brand-mark">
            <Network size={23} strokeWidth={1.6} />
          </span>
          <span>
            RDFscope
            <small>{browserMode ? "Browser edition" : "RDF explorer"}</small>
          </span>
        </a>
        <div className="source-block">
          <div className="source-label">
            <span>
              <FileCode2 size={13} />
              {summary?.source === "endpoint"
                ? "Connected endpoint"
                : "Current dataset"}
            </span>
            <button
              className="icon-button"
              title="Open another dataset"
              aria-label="Open another dataset"
              onClick={() => openSource("file")}
            >
              <Plus size={15} />
            </button>
          </div>
          <strong title={summary?.name}>
            {summary?.name || "Loading dataset…"}
          </strong>
          <div className="source-meta">
            <span className="status-dot" />
            {summary?.sampled
              ? "Endpoint sample"
              : summary?.source === "sample"
                ? "Sample dataset"
                : "Local file"}
            <span className="source-count">
              {summary?.triples.toLocaleString() || "—"} triples
            </span>
          </div>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            ref={searchRef}
            placeholder="Find a resource…"
            aria-label="Find a resource"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <button aria-label="Clear search" onClick={() => setSearch("")}>
              <X size={13} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>
        {summary?.source === "endpoint" && (
          <div className="search-scope" role="group" aria-label="Search scope">
            <button
              className={searchScope === "endpoint" ? "active" : ""}
              aria-pressed={searchScope === "endpoint"}
              onClick={() => setSearchScope("endpoint")}
            >
              Endpoint
            </button>
            <button
              className={searchScope === "loaded" ? "active" : ""}
              aria-pressed={searchScope === "loaded"}
              onClick={() => setSearchScope("loaded")}
            >
              Loaded data
            </button>
          </div>
        )}
        {summary?.source === "endpoint" &&
          /^[a-z][a-z0-9+.-]*:\S+$/i.test(search.trim()) && (
            <button
              className="open-iri text-button"
              onClick={() => void explore(search.trim())}
            >
              <ArrowUpRight size={13} />
              Open this IRI
            </button>
          )}
        <div className="sidebar-scroll">
          <div className="section-heading">
            <button
              onClick={() => setShowClasses(!showClasses)}
              aria-expanded={showClasses}
            >
              {showClasses ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              {summary?.sampled ? "Loaded types" : "Types"}
            </button>
            <span>{summary?.classes.length || 0}</span>
          </div>
          {showClasses && (
            <div className="class-list">
              <button
                className={!classFilter ? "active" : ""}
                onClick={() => setClassFilter("")}
              >
                <span className="all-types-icon">
                  <ShapesIcon />
                </span>
                All resources<span>{summary?.resources || 0}</span>
              </button>
              {summary?.classes.map((c) => (
                <button
                  key={c.id}
                  title={c.id}
                  className={classFilter === c.id ? "active" : ""}
                  onClick={() =>
                    setClassFilter(classFilter === c.id ? "" : c.id)
                  }
                >
                  <span
                    className="class-dot"
                    style={{
                      background:
                        palette[category({ types: [c.id] } as Resource)].color,
                    }}
                  />
                  {c.label}
                  <span>{c.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="section-heading resource-section">
            <span>Resources</span>
            <span>
              {resources.length}
              {resources.length === 200 ? "+" : ""}
            </span>
          </div>
          <div className="resource-list">
            {searchLoading && (
              <p className="empty-note" role="status">
                Searching…
              </p>
            )}
            {searchError && (
              <div className="inline-error" role="alert">
                <p>{searchError}</p>
                <button
                  className="text-button"
                  onClick={() => setSearchRetry((n) => n + 1)}
                >
                  Retry search
                </button>
              </div>
            )}
            {resources.map((r) => (
              <button
                key={r.id}
                className={`resource-row ${selected === r.id ? "active" : ""}`}
                onClick={() => void explore(r.id)}
                title={r.id}
              >
                <span
                  className="list-resource-icon"
                  style={{ color: palette[category(r)].color }}
                >
                  <ResourceIcon resource={r} />
                </span>
                <span>
                  <strong>{r.label}</strong>
                  <small>
                    {r.types.length
                      ? short(r.types[0])
                      : r.is_class
                        ? "Class"
                        : "Resource"}
                  </small>
                </span>
                <ChevronRight size={12} />
              </button>
            ))}
            {!resources.length &&
              !initial &&
              !searchLoading &&
              !searchError && (
                <div className="search-empty">
                  <Search size={20} />
                  <p>
                    {summary?.source === "endpoint" &&
                    searchScope === "endpoint" &&
                    search.trim().length < 2 &&
                    !classFilter
                      ? "Search the endpoint by label or IRI. Enter at least two characters, or choose a loaded type."
                      : "No matching resources."}
                  </p>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSearch("");
                      setClassFilter("");
                    }}
                  >
                    Clear search and type filter
                  </button>
                </div>
              )}
          </div>
          {(searchOffset > 0 || searchMore) && (
            <div className="page-controls search-pages">
              <button
                className="icon-button"
                aria-label="Previous search page"
                disabled={!searchOffset || searchLoading}
                onClick={() => setSearchOffset((n) => Math.max(0, n - 25))}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {searchOffset + 1}–{searchOffset + resources.length}
              </span>
              <button
                className="icon-button"
                aria-label="Next search page"
                disabled={!searchMore || searchLoading}
                onClick={() => setSearchOffset((n) => n + 25)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <span>
            <span className="status-dot" />
            {browserMode ? "Data stays in this tab" : "Running locally"}
          </span>
          <button
            className="icon-button"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelp(!help)}
          >
            <CircleHelp size={16} />
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close resource browser"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="workspace">
        <header className="topbar">
          <div className="workspace-title">
            <button
              className="icon-button sidebar-toggle"
              aria-label="Open resource browser"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeft size={19} />
            </button>
            <span className="workspace-symbol">
              <Network size={18} />
            </span>
            <div>
              <h1>{summary?.name || "Your graph workspace"}</h1>
              <p>
                {summary?.sampled
                  ? "Explore a live endpoint, one neighborhood at a time."
                  : browserMode
                    ? "Explore privately in your browser · Files up to 10 MB"
                    : "Every connection is a place to start."}
              </p>
            </div>
          </div>
          <div className="topbar-actions">
            {browserMode ? (
              <a
                className="button quiet connect-button"
                href="https://github.com/rvben/rdfscope#install"
                target="_blank"
                rel="noreferrer"
                aria-label="Install RDFscope"
              >
                <Download size={15} />
                <span>Get the app</span>
              </a>
            ) : (
              <button
                className="button quiet connect-button"
                aria-label="Connect endpoint"
                onClick={() => openSource("endpoint")}
              >
                <Globe size={15} />
                <span>Connect endpoint</span>
              </button>
            )}
            <button
              className="button"
              aria-label="Open file"
              onClick={() => openSource("file")}
            >
              <FolderOpen size={15} />
              <span>Open file</span>
            </button>
            <details className="export-menu">
              <summary
                className="button save-button"
                aria-label="Save and export"
              >
                <Download size={15} />
                <span>Save</span>
                <ChevronDown size={12} />
              </summary>
              <div className="menu-popover">
                <button
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    void save();
                  }}
                >
                  <Download size={15} />
                  Save workspace<small>Data + layout + query</small>
                </button>
                <button
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    exportSvg();
                  }}
                  disabled={!filtered.nodes.length}
                >
                  <Share2 size={15} />
                  Export graph as SVG
                </button>
                <button
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    void exportDataset()
                      .then((rdf) =>
                        download(
                          "rdfscope-export.nq",
                          rdf,
                          "application/n-quads",
                        ),
                      )
                      .catch(fail);
                  }}
                >
                  <FileCode2 size={15} />
                  Export RDF as N-Quads
                </button>
              </div>
            </details>
          </div>
        </header>
        <div className="viewbar">
          <nav className="view-tabs" aria-label="Workspace view">
            {(
              [
                ["graph", Network, "Graph"],
                ["table", Table2, "Resources"],
                ["query", Terminal, "SPARQL"],
                ["trace", Activity, "Trace"],
              ] as const
            )
              .filter(([key]) => !browserMode || key !== "trace")
              .map(([key, Icon, label]) => (
                <button
                  key={key}
                  className={view === key ? "active" : ""}
                  aria-current={view === key ? "page" : undefined}
                  onClick={() => {
                    setView(key);
                    if (key === "graph") setFitKey((k) => k + 1);
                  }}
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
          </nav>
          <div className="view-actions">
            {view === "graph" && (
              <>
                <button
                  className={`text-button ${labels ? "active" : ""}`}
                  aria-pressed={labels}
                  onClick={() => setLabels(!labels)}
                  title="Show relationship labels"
                >
                  <Tag size={14} />
                  <span>Labels</span>
                </button>
                <button
                  className={`text-button ${filters || hiddenFilters ? "active" : ""}`}
                  onClick={() => setFilters(!filters)}
                  aria-expanded={filters}
                >
                  <SlidersHorizontal size={14} />
                  <span>Filters</span>
                  {hiddenFilters && <i />}
                </button>
                <button
                  className="icon-button"
                  title="Undo graph change"
                  aria-label="Undo graph change"
                  disabled={!history.length}
                  onClick={undo}
                >
                  <Undo2 size={15} />
                </button>
              </>
            )}
            <button
              className={`icon-button ${inspector ? "active" : ""}`}
              title="Toggle resource inspector"
              aria-label="Toggle resource inspector"
              aria-pressed={inspector}
              onClick={() => setInspector(!inspector)}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </div>
        {filters && (
          <div className="filterbar">
            <label>
              Relationship
              <select
                aria-label="Filter relationship"
                value={predicate}
                onChange={(e) => setPredicate(e.target.value)}
              >
                <option value="">All relationships</option>
                {summary?.predicates
                  .filter((p) => !p.id.endsWith("#type"))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.count})
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Named graph
              <select
                aria-label="Filter named graph"
                value={namedGraph}
                onChange={(e) => setNamedGraph(e.target.value)}
              >
                <option value="">All graphs</option>
                {summary?.graphs.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.id === "default" ? "Default graph" : g.label} ({g.count})
                  </option>
                ))}
              </select>
            </label>
            {hiddenFilters && (
              <button className="text-button" onClick={resetFilters}>
                Clear filters
                <X size={12} />
              </button>
            )}
          </div>
        )}
        <div className="main-content">
          <div className="view-content">
            {initial ? (
              <div className="loading-view">
                <LoaderCircle className="spin" size={25} />
                <p>Opening your graph…</p>
              </div>
            ) : view === "graph" ? (
              <>
                <div className="canvas-heading">
                  <span>
                    {selected && detail ? (
                      <>
                        <span className="focus-dot" />
                        {detail.resource.label}
                      </>
                    ) : (
                      <>Graph overview</>
                    )}
                  </span>
                  <small>
                    {hiddenFilters
                      ? "Filtered view"
                      : summary?.source === "sample"
                        ? "An illustrative research library"
                        : "Explore your connections"}
                  </small>
                </div>
                <GraphCanvas
                  graph={filtered}
                  positions={positions}
                  selected={selected}
                  pinned={pinned}
                  labels={labels}
                  fitKey={fitKey}
                  minimap={minimap}
                  onSelect={(id) => void select(id)}
                  onExpand={(id) => void expand(id)}
                  onPosition={(id, p) =>
                    setPositions((current) => ({ ...current, [id]: p }))
                  }
                  onLayout={() => {
                    checkpoint();
                    setPositions(
                      layout(
                        graph,
                        Object.fromEntries(
                          Object.entries(positions).filter(([id]) =>
                            pinned.has(id),
                          ),
                        ),
                      ),
                    );
                    setFitKey((k) => k + 1);
                  }}
                  onMinimap={() => setMinimap(!minimap)}
                />
                {!filtered.nodes.length && (
                  <div className="graph-empty">
                    <Network size={32} strokeWidth={1.4} />
                    <h2>
                      {hiddenFilters
                        ? "No resources match these filters."
                        : "Your canvas is ready."}
                    </h2>
                    <p>
                      {hiddenFilters
                        ? "Clear a filter to see more of your graph."
                        : "Open an RDF file or add a resource from the browser."}
                    </p>
                    <button
                      className="button"
                      onClick={
                        hiddenFilters ? resetFilters : () => openSource("file")
                      }
                    >
                      {hiddenFilters ? "Clear filters" : "Open a file"}
                    </button>
                  </div>
                )}
                <div className="graph-legend">
                  {Object.entries({
                    work: "Works",
                    person: "People",
                    concept: "Concepts",
                    organization: "Organizations",
                    resource: "Other",
                  })
                    .filter(([key]) =>
                      filtered.nodes.some((n) => category(n) === key),
                    )
                    .map(([key, name]) => (
                      <span key={key}>
                        <i style={{ background: palette[key].color }} />
                        {name}
                      </span>
                    ))}
                </div>
              </>
            ) : view === "table" ? (
              <section className="resource-table">
                <div className="table-heading">
                  <h2>Resources on canvas</h2>
                  <span>{filtered.nodes.length} resources</span>
                </div>
                <p className="table-description">
                  The same selection, with room for the details. Click a
                  resource to inspect its RDF.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Resource</th>
                        <th>Type</th>
                        <th>Connections</th>
                        <th>IRI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.nodes.map((r) => (
                        <tr
                          key={r.id}
                          className={selected === r.id ? "selected" : ""}
                        >
                          <td>
                            <button
                              className="table-resource"
                              onClick={() => void select(r.id)}
                            >
                              <span
                                style={{ color: palette[category(r)].color }}
                              >
                                <ResourceIcon resource={r} />
                              </span>
                              {r.label}
                            </button>
                          </td>
                          <td>{r.types.map(short).join(", ") || "—"}</td>
                          <td>{r.degree}</td>
                          <td>
                            <button
                              className="term-link"
                              title={r.id}
                              onClick={() => void select(r.id)}
                            >
                              {compact(r.id)}
                              <ArrowUpRight size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!filtered.nodes.length && (
                    <p className="empty-note">
                      No resources on this canvas. Clear filters or add a
                      resource.
                    </p>
                  )}
                </div>
              </section>
            ) : view === "trace" ? (
              <TracePanel
                remote={summary?.source === "endpoint"}
                onQuery={(q) => {
                  setQuery(q);
                  setQueryResult(null);
                  setQueryError("");
                  setView("query");
                }}
              />
            ) : (
              <QueryPanel
                query={query}
                onQuery={setQuery}
                onRun={() => void runQuery()}
                busy={queryBusy}
                result={queryResult}
                error={queryError}
                onSelect={(id) => void explore(id)}
                remote={summary?.source === "endpoint"}
              />
            )}
          </div>
          {inspector && (
            <Inspector
              detail={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => selected && void select(selected)}
              onLoaded={refreshSummary}
              pinned={!!selected && pinned.has(selected)}
              onSelect={(id) => void explore(id)}
              onAddPage={addPage}
              onFocus={() => selected && void focus(selected)}
              onPin={() => {
                if (selected)
                  setPinned((p) => {
                    const next = new Set(p);
                    if (next.has(selected)) next.delete(selected);
                    else next.add(selected);
                    return next;
                  });
              }}
              onHide={() => {
                if (!selected) return;
                checkpoint();
                setGraph((g) => ({
                  ...g,
                  nodes: g.nodes.filter((n) => n.id !== selected),
                  edges: g.edges.filter(
                    (e) => e.source !== selected && e.target !== selected,
                  ),
                }));
                setSelected(null);
                setDetail(null);
              }}
              onClose={() => setInspector(false)}
            />
          )}
        </div>
        <footer className="statusbar">
          <div>
            <span className="status-dot" />
            {filtered.nodes.length} resources
            <span className="status-separator">/</span>
            {filtered.edges.length} connections
            {graph.truncated && (
              <span className="bounded-note">Bounded view</span>
            )}
            {summary?.sampled && (
              <span className="bounded-note">Cached sample</span>
            )}
          </div>
          <span>
            {summary?.graphs.length || 0} graphs{" "}
            <span className="status-separator">·</span>
            {summary?.triples.toLocaleString() || 0} loaded triples
          </span>
        </footer>
      </main>
      <OpenDialog
        open={open}
        initialTab={openTab}
        onClose={() => setOpen(false)}
        onFile={importFile}
        onConnect={connect}
        onSample={loadSample}
        busy={busy}
      />
      <input
        type="file"
        hidden
        ref={fileRef}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f).catch(fail);
        }}
      />
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {busy && !open && (
        <div className="busy-banner" role="status">
          <LoaderCircle className="spin" size={15} />
          Reading and indexing RDF…
        </div>
      )}
      {dragging && !open && (
        <div className="drop-overlay">
          <FolderOpen size={40} />
          <h2>Open a new graph</h2>
          <p>Drop your RDF file or saved workspace.</p>
        </div>
      )}
      {help && (
        <div className="help-popover">
          <div>
            <h3>
              <Command size={15} />
              Keyboard shortcuts
            </h3>
            <button
              className="icon-button"
              aria-label="Close shortcuts"
              onClick={() => setHelp(false)}
            >
              <X size={14} />
            </button>
          </div>
          <p>
            Find a resource<kbd>/</kbd>
          </p>
          <p>
            Fit graph<kbd>F</kbd>
          </p>
          <p>
            Save workspace<kbd>⌘ / Ctrl S</kbd>
          </p>
          <p>
            Run query<kbd>⌘ / Ctrl ↵</kbd>
          </p>
          <small>Double-click any node to expand its neighborhood.</small>
        </div>
      )}
    </div>
  );
}
function ShapesIcon() {
  return <Network size={13} />;
}
