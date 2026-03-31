// packages/control-plane/src/api/health.ts
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { killSwitchService } from "../engine/kill-switch";
import { natsClient } from "../messaging/nats";
import { activeExperiments } from "../observability/metrics";

export async function healthRoutes(fastify: FastifyInstance) {
  // GET /api/v1/health — used by load balancers and pre-flight checks
  fastify.get("/health", async (_request, reply) => {
    const checks = await Promise.allSettled([
      db.raw("SELECT 1"),
      // Redis check is implicit via kill switch state
      killSwitchService.getState(),
    ]);

    const dbHealthy = checks[0].status === "fulfilled";
    const ksState = checks[1].status === "fulfilled"
      ? (checks[1].value as any)
      : null;

    // Get active experiment count from Prometheus gauge
    let activeCount = 0;
    try {
      const metrics = (activeExperiments as any)._getValue?.() ?? {};
      activeCount = Object.values(metrics).reduce((sum: number, v: any) => sum + (v ?? 0), 0);
    } catch {}

    const healthy = dbHealthy;

    reply.code(healthy ? 200 : 503).send({
      healthy,
      services: {
        postgres: { healthy: dbHealthy, latencyMs: 0 },
      },
      activeExperiments: activeCount,
      globalKillSwitchEngaged: ksState?.global ?? false,
      killSwitchReason: ksState?.globalReason,
      version: process.env.npm_package_version ?? "1.0.0",
      uptime: Math.floor(process.uptime()),
    });
  });

  // GET /api/v1/readiness — Kubernetes readiness probe
  fastify.get("/readiness", async (_request, reply) => {
    try {
      await db.raw("SELECT 1");
      reply.code(200).send({ ready: true });
    } catch {
      reply.code(503).send({ ready: false });
    }
  });
}
