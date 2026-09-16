import { describe, expect, it } from "vitest";
import { layout, mergeGraph } from "./model";
import type { Graph, Resource } from "./model";
const resource = (id: string): Resource => ({
  id,
  label: id,
  types: [],
  degree: 1,
  is_class: false,
});
const graph: Graph = {
  nodes: [resource("a"), resource("b")],
  edges: [
    {
      id: "e0",
      source: "a",
      target: "b",
      predicate: "p",
      label: "p",
      graph: "g",
    },
  ],
  total: 2,
  truncated: false,
};
describe("graph exploration", () => {
  it("keeps existing positions exactly when expanding a neighborhood", () => {
    const original = layout(graph);
    const added: Graph = {
      ...graph,
      nodes: [...graph.nodes, resource("c")],
      edges: [
        ...graph.edges,
        {
          id: "e1",
          source: "b",
          target: "c",
          predicate: "p",
          label: "p",
          graph: "g",
        },
      ],
    };
    const expanded = layout(added, original);
    expect(expanded.a).toEqual(original.a);
    expect(expanded.b).toEqual(original.b);
    expect(Number.isFinite(expanded.c.x)).toBe(true);
    expect(expanded.c).not.toEqual(expanded.b);
  });
  it("deduplicates identical quads even when endpoint cache indices change", () => {
    const merged = mergeGraph(graph, {
      ...graph,
      edges: [{ ...graph.edges[0], id: "e42" }],
    });
    expect(merged.edges).toHaveLength(1);
    const named = mergeGraph(graph, {
      ...graph,
      edges: [{ ...graph.edges[0], graph: "other" }],
    });
    expect(named.edges).toHaveLength(2);
  });
  it("bounds rendering without adding edges to omitted nodes", () => {
    const large = {
      nodes: Array.from({ length: 230 }, (_, i) => resource(String(i))),
      edges: [],
      total: 230,
      truncated: false,
    };
    const merged = mergeGraph(graph, large);
    expect(merged.nodes).toHaveLength(200);
    expect(merged.truncated).toBe(true);
  });
  it("produces a repeatable layout", () => {
    expect(layout(graph)).toEqual(layout(graph));
  });
});
