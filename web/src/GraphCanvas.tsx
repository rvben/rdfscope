import { vscodeMode } from "./vscode";
import { memo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position as Side,
  useNodesState,
  useReactFlow,
  MarkerType,
  MiniMap,
  BaseEdge,
  useInternalNode,
} from "@xyflow/react";
import type {
  Node,
  NodeProps,
  Edge as FlowEdge,
  EdgeProps,
} from "@xyflow/react";
import {
  BookOpen,
  UserRound,
  Building2,
  Shapes,
  Circle,
  Plus,
  Minus,
  Scan,
  RotateCcw,
  Map,
  Pin,
} from "lucide-react";
import type { Graph, Position, Resource } from "./model";
import { category, palette, short } from "./model";

type EntityData = Record<string, unknown> & {
  resource: Resource;
  pinned: boolean;
};
type Entity = Node<EntityData, "entity">;
export function ResourceIcon({
  resource,
  size = 15,
}: {
  resource: Resource;
  size?: number;
}) {
  const Icon = {
    work: BookOpen,
    person: UserRound,
    organization: Building2,
    concept: Shapes,
    resource: Circle,
  }[category(resource)]!;
  return <Icon size={size} strokeWidth={1.7} />;
}
const EntityNode = memo(function EntityNode({
  data,
  selected,
}: NodeProps<Entity>) {
  const r = data.resource;
  const c = palette[category(r)];
  return (
    <div
      className={`entity-node ${selected ? "selected" : ""}`}
      style={
        { "--node-color": c.color, "--node-bg": c.bg } as React.CSSProperties
      }
    >
      <Handle type="target" position={Side.Left} />
      <span className="entity-icon">
        <ResourceIcon resource={r} size={17} />
      </span>
      <span className="entity-copy">
        <strong title={r.label}>{r.label}</strong>
        <small>
          {r.types.length
            ? short(r.types[0])
            : r.id.startsWith("_:")
              ? "Blank node"
              : "Resource"}
        </small>
      </span>
      {data.pinned && <Pin className="pin-indicator" size={10} />}
      <Handle type="source" position={Side.Right} />
    </div>
  );
});
const nodeTypes = { entity: EntityNode };
function RelationshipEdge(props: EdgeProps) {
  const source = useInternalNode(props.source),
    target = useInternalNode(props.target);
  if (!source || !target) return null;
  const a = source.internals.positionAbsolute,
    b = target.internals.positionAbsolute;
  const aw = source.measured.width || 190,
    ah = source.measured.height || 62,
    bw = target.measured.width || 190,
    bh = target.measured.height || 62;
  const ax = a.x + aw / 2,
    ay = a.y + ah / 2,
    bx = b.x + bw / 2,
    by = b.y + bh / 2;
  const dx = bx - ax,
    dy = by - ay,
    dist = Math.max(1, Math.hypot(dx, dy));
  if (props.source === props.target)
    return (
      <BaseEdge
        {...props}
        path={`M${ax - 25} ${a.y} C${ax - 90} ${a.y - 80} ${ax + 90} ${a.y - 80} ${ax + 25} ${a.y}`}
        labelX={ax}
        labelY={a.y - 60}
      />
    );
  const ra = Math.min(
    (aw / 2 + 2) / Math.max(0.01, Math.abs(dx)),
    (ah / 2 + 2) / Math.max(0.01, Math.abs(dy)),
  );
  const rb = Math.min(
    (bw / 2 + 3) / Math.max(0.01, Math.abs(dx)),
    (bh / 2 + 3) / Math.max(0.01, Math.abs(dy)),
  );
  const sx = ax + dx * ra,
    sy = ay + dy * ra,
    tx = bx - dx * rb,
    ty = by - dy * rb;
  const bend = 18,
    cx = (sx + tx) / 2 - (dy / dist) * bend,
    cy = (sy + ty) / 2 + (dx / dist) * bend;
  return (
    <BaseEdge
      {...props}
      path={`M${sx} ${sy} Q${cx} ${cy} ${tx} ${ty}`}
      labelX={(sx + 2 * cx + tx) / 4}
      labelY={(sy + 2 * cy + ty) / 4}
    />
  );
}
const edgeTypes = { relationship: RelationshipEdge };
interface Props {
  graph: Graph;
  positions: Record<string, Position>;
  selected: string | null;
  pinned: Set<string>;
  labels: boolean;
  fitKey: number;
  minimap: boolean;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  onPosition: (id: string, p: Position) => void;
  onLayout: () => void;
  onMinimap: () => void;
}
export default function GraphCanvas({
  graph,
  positions,
  selected,
  pinned,
  labels,
  fitKey,
  minimap,
  onSelect,
  onExpand,
  onPosition,
  onLayout,
  onMinimap,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Entity>([]);
  const flow = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef({ selected, positions, graph });
  latest.current = { selected, positions, graph };
  const frameGraph = useCallback(() => {
    if (!vscodeMode && window.matchMedia("(max-width: 700px)").matches) {
      const state = latest.current;
      const id = state.graph.nodes.some((node) => node.id === state.selected)
        ? state.selected
        : state.graph.nodes[0]?.id;
      const point = id ? state.positions[id] : undefined;
      if (point)
        void flow.setCenter(point.x + 95, point.y + 31, {
          zoom: 0.9,
          duration: 0,
        });
      return;
    }
    void flow.fitView({ padding: 0.22, maxZoom: 1.1, duration: 0 });
  }, [flow]);
  useEffect(() => {
    setNodes(
      graph.nodes.map((r) => ({
        id: r.id,
        type: "entity",
        position: positions[r.id] || { x: 0, y: 0 },
        data: { resource: r, pinned: pinned.has(r.id) },
        selected: r.id === selected,
        draggable: !pinned.has(r.id),
        ariaLabel: `${r.label}, ${r.types.map(short).join(", ") || "resource"}`,
      })),
    );
  }, [graph.nodes, positions, selected, pinned, setNodes]);
  useEffect(() => {
    const t = setTimeout(frameGraph, 100);
    return () => clearTimeout(t);
  }, [fitKey, frameGraph]);
  useEffect(() => {
    if (!vscodeMode && window.matchMedia("(max-width: 700px)").matches)
      frameGraph();
  }, [selected, frameGraph]);
  useEffect(() => {
    if (!container.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(frameGraph, 120);
    });
    observer.observe(container.current);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [frameGraph]);
  const edges: FlowEdge[] = graph.edges.map((e, i) => {
    const active = e.source === selected || e.target === selected;
    return {
      id: `${e.source}|${e.predicate}|${e.target}|${e.graph}|${i}`,
      source: e.source,
      target: e.target,
      type: "relationship",
      label: labels || active ? e.label : undefined,
      style: {
        stroke: active ? "var(--edge-active, #579984)" : "var(--edge, #b4c4ba)",
        strokeWidth: active ? 1.7 : 1.15,
        opacity: selected && !active ? 0.55 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: active ? "var(--edge-active, #579984)" : "var(--edge, #b4c4ba)",
        width: 14,
        height: 14,
      },
      labelStyle: {
        fill: active
          ? "var(--edge-label-active, #376b5b)"
          : "var(--edge-label, #65737b)",
        fontSize: 11,
        fontWeight: active ? 500 : 400,
      },
      labelBgStyle: { fill: "var(--canvas, #f8faf9)", fillOpacity: 0.96 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 3,
      interactionWidth: 12,
    };
  });
  return (
    <div
      ref={container}
      className="graph-canvas"
      aria-label="Interactive RDF graph"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => onSelect(n.id)}
        onNodeDoubleClick={(_, n) => onExpand(n.id)}
        onNodeDragStop={(_, n) => onPosition(n.id, n.position)}
        minZoom={0.15}
        maxZoom={2}
        fitView={vscodeMode || !window.matchMedia("(max-width: 700px)").matches}
        fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
        nodesConnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--graph-dot, #dce3df)"
        />
        {minimap && (
          <MiniMap
            nodeColor={(n) =>
              palette[category((n.data as EntityData).resource)].color
            }
            nodeStrokeWidth={0}
            maskColor="var(--minimap-mask, rgba(248,250,249,.75))"
            pannable
            zoomable
          />
        )}
      </ReactFlow>
      <div className="canvas-controls" role="group" aria-label="Graph controls">
        <button
          className="icon-button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={() => void flow.zoomIn({ duration: 150 })}
        >
          <Plus size={17} />
        </button>
        <button
          className="icon-button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={() => void flow.zoomOut({ duration: 150 })}
        >
          <Minus size={17} />
        </button>
        <span />
        <button
          className="icon-button"
          title="Fit graph (F)"
          aria-label="Fit graph"
          onClick={() => void flow.fitView({ padding: 0.2, duration: 250 })}
        >
          <Scan size={17} />
        </button>
        <button
          className="icon-button"
          title="Rearrange unpinned nodes"
          aria-label="Rearrange graph"
          onClick={onLayout}
        >
          <RotateCcw size={16} />
        </button>
        <button
          className={`icon-button ${minimap ? "active" : ""}`}
          title="Toggle minimap"
          aria-label="Toggle minimap"
          aria-pressed={minimap}
          onClick={onMinimap}
        >
          <Map size={16} />
        </button>
      </div>
      <div className="canvas-hint">
        Drag to arrange <span>·</span> Double-click to expand
      </div>
    </div>
  );
}
