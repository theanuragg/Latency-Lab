// packages/dashboard/src/components/SystemTopologyGraph.tsx
"use client";
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import type { Experiment } from "@chaos/shared-types";

interface Props {
  experiments: Experiment[];
  selectedExperiment: Experiment | null;
}

// Build a static topology from active experiment targets
// In production: pull this from your service mesh / K8s service graph
function buildTopology(experiments: Experiment[], selected: Experiment | null) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Collect all targeted namespaces and services
  const targeted = new Set<string>();
  for (const exp of experiments) {
    for (const t of exp.selectedTargets) {
      targeted.add(t.name);
    }
  }

  // Static example topology — replace with real service discovery
  const services = [
    { id: "api-gateway", label: "API Gateway", x: 300, y: 50 },
    { id: "auth-service", label: "Auth Service", x: 100, y: 180 },
    { id: "payment-service", label: "Payment Service", x: 300, y: 180 },
    { id: "order-service", label: "Order Service", x: 500, y: 180 },
    { id: "postgres", label: "PostgreSQL", x: 200, y: 310 },
    { id: "redis", label: "Redis", x: 400, y: 310 },
    { id: "solana-rpc", label: "Solana RPC", x: 550, y: 310 },
  ];

  for (const svc of services) {
    const isChaosTarget = targeted.has(svc.id) ||
      experiments.some(e =>
        e.config.target.labelSelector &&
        Object.values(e.config.target.labelSelector).includes(svc.id)
      );

    const isSelected = selected?.selectedTargets?.some(t => t.name === svc.id);

    nodes.push({
      id: svc.id,
      position: { x: svc.x, y: svc.y },
      data: { label: svc.label },
      style: {
        background: isSelected
          ? "rgba(239, 68, 68, 0.15)"
          : isChaosTarget
          ? "rgba(234, 179, 8, 0.10)"
          : "rgba(31, 41, 55, 0.8)",
        border: `1px solid ${isSelected ? "rgb(239,68,68)" : isChaosTarget ? "rgb(234,179,8)" : "rgb(55,65,81)"}`,
        borderRadius: 8,
        color: isSelected ? "rgb(252,165,165)" : isChaosTarget ? "rgb(253,224,71)" : "rgb(209,213,219)",
        fontSize: 12,
        padding: "6px 12px",
        minWidth: 120,
        textAlign: "center" as const,
      },
    });
  }

  // Edges
  const edgeDefs = [
    ["api-gateway", "auth-service"],
    ["api-gateway", "payment-service"],
    ["api-gateway", "order-service"],
    ["payment-service", "postgres"],
    ["payment-service", "solana-rpc"],
    ["order-service", "postgres"],
    ["order-service", "redis"],
    ["auth-service", "redis"],
  ];

  for (const [source, target] of edgeDefs) {
    edges.push({
      id: `${source}-${target}`,
      source,
      target,
      style: { stroke: "rgb(75,85,99)", strokeWidth: 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgb(75,85,99)", width: 12, height: 12 },
    });
  }

  return { nodes, edges };
}

export function SystemTopologyGraph({ experiments, selectedExperiment }: Props) {
  const { nodes, edges } = buildTopology(experiments, selectedExperiment);

  return (
    <div style={{ height: 380, background: "transparent" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        attributionPosition="bottom-right"
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#374151" gap={24} size={0.5} />
        <Controls showInteractive={false} style={{ background: "#1f2937", border: "1px solid #374151" }} />
      </ReactFlow>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-red-500/30 border border-red-500" />
          Active target
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-yellow-500/20 border border-yellow-500/50" />
          Previously targeted
        </span>
      </div>
    </div>
  );
}
