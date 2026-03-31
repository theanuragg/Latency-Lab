// packages/control-plane/src/api/experiments.ts
// REST API for experiment lifecycle management.
//
// Design choice: We use Fastify's JSON Schema validation to reject malformed
// requests at the framework level, before they reach our business logic.
// This gives us free 400 responses with useful error messages.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import type {
  CreateExperimentRequest,
  ExperimentConfig,
  KillSwitchRequest,
} from "@chaos/shared-types";
import { policyEngine } from "../policy/engine";
import { experimentRepository } from "../db/repositories/experiments";
import { chaosScheduler } from "../scheduler";
import { natsClient } from "../messaging/nats";
import { logger } from "../observability/logger";
import { requireAuth, requireRole } from "./middleware/auth";

// ─── Zod schema for runtime validation ─────────────────────────────────────────
// Zod gives us runtime type safety + useful error messages for free.
// Important: Every field has a .describe() for API documentation.

const targetSelectorSchema = z.object({
  namespace: z.string().min(1).optional().describe("Kubernetes namespace"),
  labelSelector: z.record(z.string()).optional(),
  deploymentName: z.string().optional(),
  nodeName: z.string().optional(),
  rpcEndpoints: z.array(z.string().url()).optional(),
  serviceNames: z.array(z.string()).optional(),
});

const safetyConfigSchema = z.object({
  requireHealthyBefore: z.boolean().default(true),
  healthCheckEndpoints: z.array(z.string().url()).optional(),
  maxErrorRatePct: z.number().min(0).max(100).optional(),
  maxLatencyMs: z.number().positive().optional(),
  minPodsAvailable: z.number().int().positive().optional(),
  requireHealthyAfter: z.boolean().default(true),
  recoveryTimeoutSeconds: z.number().positive().optional().default(300),
  blockedNamespaces: z.array(z.string()).optional(),
  autoRollback: z.boolean().default(true),
});

const experimentConfigSchema = z.object({
  name: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/, "Name must be kebab-case"),
  description: z.string().max(500).optional(),
  type: z.enum([
    "pod-kill", "network-latency", "network-loss", "network-partition",
    "rpc-timeout", "rpc-corrupt", "rpc-latency",
    "cpu-stress", "memory-exhaust", "disk-throttle",
    "node-drain", "dependency-kill",
  ]),
  target: targetSelectorSchema,
  action: z.record(z.unknown()), // typed per-runner
  blastRadius: z.object({
    unit: z.enum(["percentage", "count"]),
    value: z.number().positive(),
    maxCount: z.number().int().positive().optional(),
  }),
  duration: z.string().regex(/^\d+[smh]$/, "Use Go-style duration: '30s', '5m', '2h'"),
  schedule: z.string().optional().describe("Cron expression for recurring experiments"),
  continuous: z.boolean().optional().default(false),
  safety: safetyConfigSchema,
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
});

// ─── Route handlers ─────────────────────────────────────────────────────────────

export async function experimentRoutes(fastify: FastifyInstance) {
  // POST /api/v1/experiment
  // Creates and optionally starts an experiment. With dryRun=true, returns
  // what WOULD happen without executing anything.
  fastify.post("/experiment", {
    preHandler: [requireAuth],
    schema: {
      body: experimentConfigSchema,
      querystring: z.object({ dryRun: z.boolean().optional() }),
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as ExperimentConfig;
    const { dryRun } = request.query as { dryRun?: boolean };
    const user = (request as any).user;

    const log = logger.child({ experimentName: body.name, user: user.sub });
    log.info("Creating experiment");

    // Step 1: Validate via Zod (already done by schema above)
    // Step 2: Policy check
    const policyContext = { requestingUser: user.sub, userRoles: user.roles ?? [] };

    if (dryRun) {
      const report = await policyEngine.dryRun(body, policyContext);
      return reply.code(200).send(report);
    }

    const policyResult = await policyEngine.evaluate(body, policyContext);

    if (!policyResult.allowed) {
      return reply.code(403).send({
        error: "POLICY_VIOLATION",
        violations: policyResult.violations.filter((v) => v.severity === "block"),
        warnings: policyResult.warnings,
      });
    }

    // Step 3: Persist experiment
    const id = randomUUID();
    await experimentRepository.create({
      id,
      config: body,
      status: "pending",
      createdBy: user.sub,
      createdAt: new Date(),
      selectedTargets: [],
      events: [],
    });

    // Step 4: Schedule or start immediately
    if (body.schedule) {
      await chaosScheduler.schedule(id, body.schedule);
      log.info({ experimentId: id }, "Experiment scheduled");
    } else {
      // Publish to NATS — the chaos engine workers pick this up
      // This is fire-and-forget from the API's perspective;
      // the engine updates status via the database
      await natsClient.publish("chaos.experiment.start", {
        experimentId: id,
        config: body,
        requestedBy: user.sub,
      });
      log.info({ experimentId: id }, "Experiment queued for execution");
    }

    reply.code(201).send({
      experimentId: id,
      status: "pending",
      warnings: policyResult.warnings,
    });
  });

  // GET /api/v1/experiments
  fastify.get("/experiments", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const query = request.query as {
      status?: string;
      namespace?: string;
      limit?: number;
      offset?: number;
    };

    const experiments = await experimentRepository.list({
      status: query.status as any,
      namespace: query.namespace,
      limit: Math.min(query.limit ?? 20, 100),
      offset: query.offset ?? 0,
    });

    reply.send({ experiments, total: experiments.length });
  });

  // GET /api/v1/experiment/:id
  fastify.get("/experiment/:id", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const experiment = await experimentRepository.findById(id);

    if (!experiment) {
      return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });
    }

    reply.send(experiment);
  });

  // PATCH /api/v1/experiment/:id/pause
  // Pauses a running experiment — the engine will complete current actions
  // but not start new ones
  fastify.patch("/experiment/:id/pause", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    const experiment = await experimentRepository.findById(id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });
    if (experiment.status !== "running") {
      return reply.code(409).send({ error: "EXPERIMENT_NOT_RUNNING" });
    }

    await natsClient.publish("chaos.experiment.pause", { experimentId: id, requestedBy: user.sub });
    await experimentRepository.updateStatus(id, "paused");

    reply.send({ status: "paused" });
  });

  // DELETE /api/v1/experiment/:id
  // Hard cancel — triggers cleanup and rollback
  fastify.delete("/experiment/:id", {
    preHandler: [requireAuth, requireRole("chaos-operator")],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const user = (request as any).user;

    const experiment = await experimentRepository.findById(id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });

    await natsClient.publish("chaos.experiment.kill", {
      experimentId: id,
      requestedBy: user.sub,
      reason: reason ?? "Manually cancelled",
    });

    await experimentRepository.updateStatus(id, "killed", {
      rollbackReason: reason,
    });

    reply.send({ status: "killed" });
  });

  // POST /api/v1/experiment/:id/replay
  // Replay a past experiment — great for reproducing production incidents
  fastify.post("/experiment/:id/replay", {
    preHandler: [requireAuth, requireRole("chaos-operator")],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = (request as any).user;

    const original = await experimentRepository.findById(id);
    if (!original) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND" });

    // Create a new experiment with the same config but a new ID and name
    const newId = randomUUID();
    const replayConfig: ExperimentConfig = {
      ...original.config,
      name: `${original.config.name}-replay-${Date.now()}`,
      annotations: {
        ...original.config.annotations,
        "chaos.io/replay-of": id,
      },
    };

    await experimentRepository.create({
      id: newId,
      config: replayConfig,
      status: "pending",
      createdBy: user.sub,
      createdAt: new Date(),
      selectedTargets: [],
      events: [],
    });

    await natsClient.publish("chaos.experiment.start", {
      experimentId: newId,
      config: replayConfig,
      requestedBy: user.sub,
    });

    reply.code(201).send({ experimentId: newId, replayOf: id });
  });

  // POST /api/v1/dry-run
  // Evaluate a config without creating an experiment record
  fastify.post("/dry-run", {
    preHandler: [requireAuth],
  }, async (request, reply) => {
    const body = request.body as ExperimentConfig;
    const user = (request as any).user;

    const report = await policyEngine.dryRun(body, {
      requestingUser: user.sub,
      userRoles: user.roles ?? [],
    });

    reply.send(report);
  });
}
