// packages/control-plane/src/api/metrics.ts
// Metrics API — exposes system health data and chaos impact measurements.
// Proxies Prometheus queries so the dashboard doesn't need direct Prometheus access.

import type { FastifyInstance } from "fastify";
import { requireAuth } from "./middleware/auth";
import { experimentRepository } from "../db/repositories/experiments";
import { config } from "../server";
import { logger } from "../observability/logger";

export async function metricsRoutes(fastify: FastifyInstance) {
  // GET /api/v1/metrics/overview — dashboard summary stats
  fastify.get("/metrics/overview", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { namespace } = request.query as { namespace?: string };

    try {
      const [errorRate, p99Latency, requestRate] = await Promise.allSettled([
        queryPrometheus(
          `sum(rate(http_requests_total{namespace="${namespace ?? "production"}",status=~"5.."}[5m])) / sum(rate(http_requests_total{namespace="${namespace ?? "production"}"}[5m])) * 100`
        ),
        queryPrometheus(
          `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{namespace="${namespace ?? "production"}"}[5m])) by (le)) * 1000`
        ),
        queryPrometheus(
          `sum(rate(http_requests_total{namespace="${namespace ?? "production"}"}[5m]))`
        ),
      ]);

      reply.send({
        errorRatePct: resolveValue(errorRate, null),
        p99LatencyMs: resolveValue(p99Latency, null),
        requestsPerSec: resolveValue(requestRate, null),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err }, "Metrics overview query failed");
      reply.code(502).send({ error: "PROMETHEUS_UNAVAILABLE" });
    }
  });

  // GET /api/v1/metrics/resilience?namespace=X — resilience score trend
  fastify.get("/metrics/resilience", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { namespace = "production", limit = 30 } = request.query as {
      namespace?: string;
      limit?: number;
    };

    const scores = await experimentRepository.getResilienceScores(
      namespace,
      Math.min(Number(limit), 100)
    );

    const avg =
      scores.length > 0
        ? Math.round(scores.reduce((s, r) => s + r.score, 0) / scores.length)
        : null;

    reply.send({
      namespace,
      average: avg,
      trend: scores,
      totalExperiments: scores.length,
    });
  });

  // GET /api/v1/metrics/experiment/:id — before/after metrics for a specific experiment
  fastify.get("/metrics/experiment/:id", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const experiment = await experimentRepository.findById(id);
    if (!experiment) {
      return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });
    }

    reply.send({
      experimentId: id,
      metrics: experiment.metrics ?? null,
      events: experiment.events,
    });
  });

  // POST /api/v1/metrics/query — raw Prometheus query proxy
  // Allows the dashboard to make arbitrary PromQL queries without CORS issues
  fastify.post("/metrics/query", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { query, time } = request.body as { query: string; time?: string };

    if (!query) {
      return reply.code(400).send({ error: "query is required" });
    }

    try {
      const params = new URLSearchParams({ query });
      if (time) params.set("time", time);

      const response = await fetch(`${config.prometheusUrl}/api/v1/query?${params}`, {
        signal: AbortSignal.timeout(10_000),
      });

      const data = await response.json();
      reply.send(data);
    } catch (err: any) {
      reply.code(502).send({ error: "PROMETHEUS_UNAVAILABLE", message: err.message });
    }
  });
}

async function queryPrometheus(query: string): Promise<number | null> {
  const url = `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return null;
  const data: any = await response.json();
  if (data.status !== "success" || !data.data.result.length) return null;
  return parseFloat(data.data.result[0].value[1]);
}

function resolveValue(result: PromiseSettledResult<number | null>, fallback: any) {
  if (result.status === "rejected") return fallback;
  return result.value ?? fallback;
}
