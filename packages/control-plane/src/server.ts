// packages/control-plane/src/server.ts
// The control plane is the brain — it schedules experiments, enforces policy,
// and provides the API surface. It does NOT execute chaos directly; it publishes
// events to NATS which the chaos engine workers consume. This decoupling means
// a control plane restart never affects running experiments.

import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import FastifyJwt from "@fastify/jwt";
import FastifyCors from "@fastify/cors";
import FastifyHelmet from "@fastify/helmet";
import { metricsPlugin } from "./observability/metrics";
import { experimentRoutes } from "./api/experiments";
import { killSwitchRoutes } from "./api/kill-switch";
import { metricsRoutes } from "./api/metrics";
import { healthRoutes } from "./api/health";
import { db } from "./db";
import { killSwitchService } from "./engine/kill-switch";
import { logger } from "./observability/logger";

// Configuration — loaded from env, validated at startup
const config = {
  port: parseInt(process.env.PORT ?? "3000"),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? (() => { throw new Error("JWT_SECRET required"); })(),
  pgUrl: process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL required"); })(),
  redisUrl: process.env.REDIS_URL ?? (() => { throw new Error("REDIS_URL required"); })(),
  natsUrl: process.env.NATS_URL ?? "nats://localhost:4222",
  // Global blocklist — system namespaces that can NEVER be targeted
  blockedNamespaces: (process.env.BLOCKED_NAMESPACES ?? "kube-system,kube-public,kube-node-lease").split(","),
  // Maximum blast radius allowed by any experiment, regardless of config
  maxBlastRadiusPct: parseInt(process.env.MAX_BLAST_RADIUS_PCT ?? "30"),
  prometheusUrl: process.env.PROMETHEUS_URL ?? "http://prometheus:9090",
};

export { config };

const server = Fastify({
  logger: false, // We use our own structured logger
  trustProxy: true,
  ajv: {
    customOptions: {
      strict: true,
      allErrors: true,
    },
  },
});

async function build() {
  // Security
  await server.register(FastifyHelmet);
  await server.register(FastifyCors, {
    origin: process.env.CORS_ORIGIN ?? "*",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  // Auth — JWT-based, RBAC enforced per-route
  await server.register(FastifyJwt, { secret: config.jwtSecret });

  // Prometheus metrics endpoint
  await server.register(metricsPlugin);

  // Request logging with trace IDs — every request gets a trace ID
  // that we propagate to chaos events for correlation
  server.addHook("onRequest", async (request: FastifyRequest) => {
    request.log = logger.child({
      traceId: request.headers["x-trace-id"] ?? crypto.randomUUID(),
      method: request.method,
      url: request.url,
    });
  });

  // CRITICAL: Kill switch check on every mutation endpoint.
  // This must be in the request lifecycle, not in individual route handlers.
  // If the kill switch is engaged, all experiment mutations are rejected
  // before they ever touch the database.
  server.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const mutationMethods = ["POST", "PATCH", "DELETE", "PUT"];
    const experimentPath = request.url.includes("/experiment");

    if (mutationMethods.includes(request.method) && experimentPath) {
      // Kill switch bypass — only the kill switch endpoint itself is exempt
      if (request.url.includes("/kill-switch")) return;

      const ks = await killSwitchService.getState();
      if (ks.global) {
        reply.code(503).send({
          error: "KILL_SWITCH_ENGAGED",
          message: `Global kill switch is active: ${ks.globalReason}`,
        });
        return;
      }
    }
  });

  // Routes
  await server.register(experimentRoutes, { prefix: "/api/v1" });
  await server.register(killSwitchRoutes, { prefix: "/api/v1" });
  await server.register(metricsRoutes, { prefix: "/api/v1" });
  await server.register(healthRoutes, { prefix: "/api/v1" });

  return server;
}

async function main() {
  const app = await build();

  // Graceful shutdown — finish in-flight requests, then close
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down control plane");
    await app.close();
    await db.destroy();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port }, "Control plane listening");
  } catch (err) {
    logger.error({ err }, "Failed to start control plane");
    process.exit(1);
  }
}

main();
