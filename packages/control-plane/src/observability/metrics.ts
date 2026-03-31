// packages/control-plane/src/observability/metrics.ts
// Prometheus metrics for the chaos platform itself.
// These tell you how the platform is behaving, separate from the target system metrics.

import fp from "fastify-plugin";
import { register, Counter, Histogram, Gauge } from "prom-client";
import type { FastifyInstance } from "fastify";

// Experiment lifecycle counters
export const experimentStarted = new Counter({
  name: "chaos_experiments_started_total",
  help: "Total experiments started",
  labelNames: ["type", "namespace"],
});

export const experimentCompleted = new Counter({
  name: "chaos_experiments_completed_total",
  help: "Total experiments completed",
  labelNames: ["type", "status", "namespace"],
});

export const experimentRolledBack = new Counter({
  name: "chaos_experiments_rolled_back_total",
  help: "Total auto-rollbacks triggered",
  labelNames: ["type", "reason"],
});

export const killSwitchEngaged = new Counter({
  name: "chaos_kill_switch_engaged_total",
  help: "Total kill switch engage events",
  labelNames: ["scope"],
});

export const activeExperiments = new Gauge({
  name: "chaos_active_experiments",
  help: "Currently running experiments",
  labelNames: ["type"],
});

export const chaosScoreGauge = new Gauge({
  name: "chaos_resilience_score",
  help: "Latest chaos resilience score per namespace",
  labelNames: ["namespace"],
});

export const experimentDuration = new Histogram({
  name: "chaos_experiment_duration_seconds",
  help: "Experiment execution duration",
  labelNames: ["type", "status"],
  buckets: [30, 60, 120, 300, 600, 1800, 3600],
});

export const policyViolations = new Counter({
  name: "chaos_policy_violations_total",
  help: "Policy violations encountered",
  labelNames: ["rule", "severity"],
});

// Fastify plugin that exposes /metrics endpoint
export const metricsPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.get("/metrics", async (_request, reply) => {
    reply
      .header("Content-Type", register.contentType)
      .send(await register.metrics());
  });
});
