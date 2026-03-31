// packages/shared-types/src/index.ts
// This is the single source of truth for all cross-service contracts.
// Every package imports from here — no ad-hoc interfaces spread across repos.

// ─── Experiment types ──────────────────────────────────────────────────────────

export type ExperimentType =
  | "pod-kill"
  | "network-latency"
  | "network-loss"
  | "network-partition"
  | "rpc-timeout"
  | "rpc-corrupt"
  | "rpc-latency"
  | "cpu-stress"
  | "memory-exhaust"
  | "disk-throttle"
  | "node-drain"
  | "dependency-kill";

export type ExperimentStatus =
  | "pending"
  | "dry-run"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "rolled-back"
  | "killed";

export type BlastRadiusUnit = "percentage" | "count";

// This is the canonical experiment config — maps 1:1 to the YAML format.
// Engineers should be able to write these by hand without reading the API docs.
export interface ExperimentConfig {
  name: string;
  description?: string;
  type: ExperimentType;

  target: TargetSelector;

  action: ExperimentAction;

  blastRadius: {
    unit: BlastRadiusUnit;
    value: number; // percentage: 0-100, count: 1-N
    maxCount?: number; // safety cap when using percentage
  };

  duration: string; // Go-style duration: "5m", "30s", "2h"
  schedule?: string; // cron expression for recurring experiments
  continuous?: boolean;

  // Safety configuration — these can only be made MORE restrictive, never relaxed
  safety: SafetyConfig;

  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface TargetSelector {
  namespace?: string; // defaults to non-system namespaces
  labelSelector?: Record<string, string>;
  deploymentName?: string;
  nodeName?: string;
  rpcEndpoints?: string[]; // for RPC chaos
  serviceNames?: string[]; // for network partition
}

// Union type — the specific action depends on experiment type
export type ExperimentAction =
  | PodKillAction
  | NetworkChaosAction
  | RPCChaosAction
  | ResourceChaosAction
  | DependencyChaosAction;

export interface PodKillAction {
  type: "pod-kill";
  mode: "random" | "rolling" | "burst";
  rollingInterval?: string; // for rolling mode: time between kills
  gracePeriodSeconds?: number;
}

export interface NetworkChaosAction {
  type: "network-latency" | "network-loss" | "network-partition";
  latencyMs?: number;
  jitterMs?: number;
  lossPercent?: number;
  correlationPercent?: number; // how correlated consecutive packets are
  isolateFrom?: string[]; // service names to partition from
  direction?: "ingress" | "egress" | "both";
}

export interface RPCChaosAction {
  type: "rpc-timeout" | "rpc-corrupt" | "rpc-latency";
  latencyMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  errorRate?: number; // 0-1
  corruptionMode?: "invalid-json" | "truncate" | "wrong-method" | "connection-refused";
}

export interface ResourceChaosAction {
  type: "cpu-stress" | "memory-exhaust" | "disk-throttle";
  cpuLoadPercent?: number;
  memoryBytes?: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  workers?: number; // number of stress-ng workers
}

export interface DependencyChaosAction {
  type: "dependency-kill";
  target: "redis" | "postgres" | "kafka" | "custom";
  customEndpoint?: string;
  blockMode: "drop" | "refuse" | "timeout";
}

export interface SafetyConfig {
  // Pre-flight: system must be healthy before chaos starts
  requireHealthyBefore: boolean;
  healthCheckEndpoints?: string[];

  // Guardrails during chaos
  maxErrorRatePct?: number; // abort if error rate exceeds this
  maxLatencyMs?: number; // abort if p99 latency exceeds this
  minPodsAvailable?: number; // abort if healthy pods drop below this

  // Post-chaos: system must recover
  requireHealthyAfter: boolean;
  recoveryTimeoutSeconds?: number;

  // Namespace restrictions (additive to global blocklist)
  blockedNamespaces?: string[];

  autoRollback: boolean;
}

// ─── Experiment runtime types ──────────────────────────────────────────────────

export interface Experiment {
  id: string;
  config: ExperimentConfig;
  status: ExperimentStatus;
  createdBy: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  // The actual targets that were selected (after blast radius calculation)
  selectedTargets: SelectedTarget[];
  events: ExperimentEvent[];
  metrics?: ExperimentMetrics;
  rollbackReason?: string;
}

export interface SelectedTarget {
  kind: "pod" | "node" | "service" | "rpc-endpoint";
  name: string;
  namespace?: string;
  metadata?: Record<string, string>;
}

export interface ExperimentEvent {
  timestamp: Date;
  level: "info" | "warn" | "error";
  phase: "pre-flight" | "execution" | "monitoring" | "cleanup" | "rollback";
  message: string;
  data?: Record<string, unknown>;
}

export interface ExperimentMetrics {
  // Captured via Prometheus queries, before/after comparison
  errorRateBefore?: number;
  errorRateAfter?: number;
  errorRatePeak?: number;
  p50LatencyMsBefore?: number;
  p99LatencyMsBefore?: number;
  p50LatencyMsDuring?: number;
  p99LatencyMsDuring?: number;
  mttrSeconds?: number; // mean time to recovery
  sloViolations?: SLOViolation[];
  chaosScore?: number; // 0-100, higher = more resilient
}

export interface SLOViolation {
  sloName: string;
  threshold: number;
  actual: number;
  durationSeconds: number;
}

// ─── API request/response types ───────────────────────────────────────────────

export interface CreateExperimentRequest {
  config: ExperimentConfig;
  dryRun?: boolean;
}

export interface CreateExperimentResponse {
  experimentId: string;
  status: ExperimentStatus;
  dryRunReport?: DryRunReport;
}

export interface DryRunReport {
  wouldTarget: SelectedTarget[];
  wouldBlastRadius: number;
  estimatedImpact: string;
  policyViolations: PolicyViolation[];
  warnings: string[];
}

export interface PolicyViolation {
  rule: string;
  reason: string;
  severity: "block" | "warn";
}

export interface KillSwitchRequest {
  scope: "global" | "namespace" | "experiment";
  namespace?: string;
  experimentId?: string;
  reason: string;
}

export interface HealthCheckResponse {
  healthy: boolean;
  services: Record<string, { healthy: boolean; latencyMs: number; error?: string }>;
  activeExperiments: number;
  globalKillSwitchEngaged: boolean;
}

// ─── Observability types ──────────────────────────────────────────────────────

// Every chaos action emits this to NATS — consumed by the metrics collector
export interface ChaosEvent {
  experimentId: string;
  experimentName: string;
  type: ExperimentType;
  phase: "started" | "action-applied" | "monitoring" | "cleanup" | "completed" | "rolled-back";
  target?: SelectedTarget;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// ─── Kill switch (Redis-backed, survives control plane restarts) ───────────────

export interface KillSwitchState {
  global: boolean;
  globalReason?: string;
  namespaces: Record<string, { blocked: boolean; reason: string; timestamp: Date }>;
  experiments: Record<string, { killed: boolean; reason: string; timestamp: Date }>;
  updatedAt: Date;
}
