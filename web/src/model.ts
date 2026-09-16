import { request } from "#transport";
export interface Term {
  kind: "uri" | "bnode" | "literal";
  value: string;
  language?: string;
  datatype?: string;
}
export interface Resource {
  id: string;
  label: string;
  types: string[];
  description?: string;
  degree: number;
  is_class: boolean;
}
export interface Edge {
  id: string;
  source: string;
  target: string;
  predicate: string;
  label: string;
  graph: string;
}
export interface Graph {
  nodes: Resource[];
  edges: Edge[];
  total: number;
  truncated: boolean;
}
export interface Facet {
  id: string;
  label: string;
  count: number;
}
export interface Summary {
  name: string;
  source: string;
  endpoint?: string;
  triples: number;
  resources: number;
  relationships: number;
  classes: Facet[];
  predicates: Facet[];
  graphs: Facet[];
  sampled: boolean;
}
export interface Statement {
  subject: string;
  predicate: string;
  object: Term;
  graph: string;
}
export interface ConnectionPage {
  graph: Graph;
  statements: Statement[];
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  total: number | null;
  scope: "local" | "cache" | "endpoint";
  warnings: string[];
}
export interface RelationGroups {
  groups: {
    predicate: string;
    label: string;
    direction: string;
    count: number;
  }[];
  has_more: boolean;
  scope: string;
}
export interface SearchPage {
  items: Resource[];
  has_more: boolean;
  next_offset: number | null;
  scope: string;
  warnings: string[];
}
export interface Detail {
  scope?: string;
  properties_more?: boolean;
  resource: Resource;
  outgoing: Statement[];
  incoming: Statement[];
  outgoing_total: number;
  incoming_total: number;
}
export interface QueryResult {
  kind: "bindings" | "boolean";
  value?: boolean;
  columns?: string[];
  rows?: Record<string, Term>[];
  truncated?: boolean;
  elapsed_ms: number;
}
export type Position = { x: number; y: number };
export const short = (id: string) =>
  id.split(/[/#]/).filter(Boolean).pop()?.replaceAll("_", " ") || id;
const prefixes: Record<string, string> = {
  "https://schema.org/": "schema:",
  "http://schema.org/": "schema:",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf:",
  "http://www.w3.org/2000/01/rdf-schema#": "rdfs:",
  "http://www.w3.org/2001/XMLSchema#": "xsd:",
  "http://www.w3.org/2004/02/skos/core#": "skos:",
  "http://xmlns.com/foaf/0.1/": "foaf:",
  "https://example.org/": "ex:",
};
export function compact(id: string) {
  for (const [ns, prefix] of Object.entries(prefixes)) {
    if (id.startsWith(ns)) return prefix + id.slice(ns.length);
  }
  return id;
}
export function category(r: Resource): string {
  const types = r.types.map(short).join(" ").toLowerCase();
  if (types.includes("person")) return "person";
  if (/book|article|creativework|document/.test(types)) return "work";
  if (/organization|organisation/.test(types)) return "organization";
  if (/term|concept|class/.test(types) || r.is_class) return "concept";
  return "resource";
}
export const palette: Record<string, { color: string; bg: string }> = {
  person: { color: "#a05a20", bg: "#fff5e8" },
  work: { color: "#4266a8", bg: "#edf3ff" },
  organization: { color: "#80539e", bg: "#f5edfa" },
  concept: { color: "#237761", bg: "#eaf6ef" },
  resource: { color: "#606b79", bg: "#f0f2f5" },
};
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(path, body, signal);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* Plain HTTP errors are also readable. */
    }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response.json();
}
export async function exportDataset(): Promise<string> {
  const response = await request("/export");
  if (!response.ok) throw new Error("Could not export the loaded dataset.");
  return response.text();
}
export function download(
  name: string,
  content: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const defaultQuery = `# Include the default graph and named graphs\nSELECT ?subject ?predicate ?object ?graph\nWHERE {\n  { ?subject ?predicate ?object }\n  UNION\n  { GRAPH ?graph { ?subject ?predicate ?object } }\n}\nLIMIT 100`;

// Deterministic force layout. Existing nodes remain fixed during neighborhood expansion.
export function layout(
  graph: Graph,
  existing: Record<string, Position> = {},
  center?: Position,
): Record<string, Position> {
  const nodes = graph.nodes.map((r, i) => ({
    id: r.id,
    x:
      existing[r.id]?.x ??
      (center?.x ?? 500) + Math.cos(i * 2.39996) * Math.sqrt(i + 1) * 115,
    y:
      existing[r.id]?.y ??
      (center?.y ?? 350) + Math.sin(i * 2.39996) * Math.sqrt(i + 1) * 95,
    fixed: !!existing[r.id],
  }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const pairs = graph.edges
    .map((e) => [index.get(e.source), index.get(e.target)])
    .filter(
      (p): p is [number, number] => p[0] !== undefined && p[1] !== undefined,
    );
  for (let t = 0; t < 180; t++) {
    const forces = nodes.map(() => ({ x: 0, y: 0 }));
    const cool = 1 - t / 200;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x,
          dy = nodes[j].y - nodes[i].y;
        const dist = Math.max(5, Math.hypot(dx, dy));
        if (dist === 5) {
          dx = 5;
          dy = 2;
        }
        let f = 24000 / (dist * dist);
        if (Math.abs(dx) < 215 && Math.abs(dy) < 90) f += 8;
        forces[i].x -= (dx / dist) * f;
        forces[i].y -= (dy / dist) * f;
        forces[j].x += (dx / dist) * f;
        forces[j].y += (dy / dist) * f;
      }
    for (const [a, b] of pairs) {
      const dx = nodes[b].x - nodes[a].x,
        dy = nodes[b].y - nodes[a].y,
        dist = Math.max(1, Math.hypot(dx, dy)),
        f = (dist - 240) * 0.012;
      forces[a].x += (dx / dist) * f;
      forces[a].y += (dy / dist) * f;
      forces[b].x -= (dx / dist) * f;
      forces[b].y -= (dy / dist) * f;
    }
    nodes.forEach((n, i) => {
      if (n.fixed) return;
      const f = forces[i];
      f.x += (500 - n.x) * 0.0015;
      f.y += (350 - n.y) * 0.0015;
      n.x += Math.max(-15, Math.min(15, f.x)) * cool;
      n.y += Math.max(-15, Math.min(15, f.y)) * cool;
    });
  }
  return Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

export function mergeGraph(previous: Graph, added: Graph): Graph {
  const nodes = new Map(previous.nodes.map((n) => [n.id, n]));
  let omitted = false;
  for (const n of added.nodes)
    if (nodes.has(n.id) || nodes.size < 200) nodes.set(n.id, n);
    else omitted = true;
  // Backend edge indices may change when an endpoint cache grows; quad identity is stable.
  const edges = new Map<string, Edge>();
  for (const e of [...previous.edges, ...added.edges])
    if (nodes.has(e.source) && nodes.has(e.target))
      edges.set(JSON.stringify([e.source, e.predicate, e.target, e.graph]), e);
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].slice(0, 2000),
    total: Math.max(previous.total, added.total, nodes.size),
    truncated:
      previous.truncated || added.truncated || omitted || edges.size > 2000,
  };
}
