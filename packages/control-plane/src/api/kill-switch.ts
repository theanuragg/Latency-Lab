// packages/control-plane/src/api/kill-switch.ts
// The kill switch API is the most important safety surface.
// It must be:
//   a) Fast — no database round-trips in the critical path
//   b) Durable — survives control plane restarts
//   c) Audited — every engage/disengage is logged immutably
//   d) Accessible — works even when other systems are degraded

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { KillSwitchRequest } from "@chaos/shared-types";
import { killSwitchService } from "../engine/kill-switch";
import { db } from "../db";
import { requireAuth, requireRole } from "./middleware/auth";
import { logger } from "../observability/logger";

const killSwitchRequestSchema = z.object({
  scope: z.enum(["global", "namespace", "experiment"]),
  namespace: z.string().optional(),
  experimentId: z.string().uuid().optional(),
  reason: z.string().min(1).max(500),
});

export async function killSwitchRoutes(fastify: FastifyInstance) {
  // POST /api/v1/kill-switch
  // Engage the kill switch. Requires chaos-operator role minimum.
  // Global kill switch requires chaos-admin role.
  fastify.post("/kill-switch", {
    preHandler: [requireAuth, requireRole("chaos-operator")],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as KillSwitchRequest;
    const user = (request as any).user;

    // Validate
    const parsed = killSwitchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "VALIDATION_ERROR", details: parsed.error });
    }

    // Global kill switch requires chaos-admin
    if (parsed.data.scope === "global" && !user.roles?.includes("chaos-admin")) {
      return reply.code(403).send({
        error: "INSUFFICIENT_ROLE",
        message: "Global kill switch requires chaos-admin role",
      });
    }

    // Namespace/experiment validation
    if (parsed.data.scope === "namespace" && !parsed.data.namespace) {
      return reply.code(400).send({ error: "NAMESPACE_REQUIRED" });
    }
    if (parsed.data.scope === "experiment" && !parsed.data.experimentId) {
      return reply.code(400).send({ error: "EXPERIMENT_ID_REQUIRED" });
    }

    logger.warn(
      {
        scope: parsed.data.scope,
        reason: parsed.data.reason,
        requestedBy: user.sub,
        namespace: parsed.data.namespace,
        experimentId: parsed.data.experimentId,
      },
      "Kill switch engage requested"
    );

    // Engage the kill switch (writes to Redis, broadcasts to NATS)
    await killSwitchService.engage(parsed.data, user.sub);

    // Write immutable audit record
    await db("kill_switch_audit").insert({
      action: "engage",
      scope: parsed.data.scope,
      namespace: parsed.data.namespace ?? null,
      experiment_id: parsed.data.experimentId ?? null,
      reason: parsed.data.reason,
      requested_by: user.sub,
    });

    reply.code(200).send({
      engaged: true,
      scope: parsed.data.scope,
      message: parsed.data.scope === "global"
        ? "GLOBAL kill switch engaged — all chaos halted immediately"
        : `Kill switch engaged for ${parsed.data.scope} ${parsed.data.namespace ?? parsed.data.experimentId}`,
    });
  });

  // DELETE /api/v1/kill-switch
  // Disengage the kill switch. Same role requirements as engage.
  fastify.delete("/kill-switch", {
    preHandler: [requireAuth, requireRole("chaos-operator")],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { scope, namespace } = request.query as {
      scope?: "global" | "namespace";
      namespace?: string;
    };
    const user = (request as any).user;

    const resolvedScope = scope ?? "global";

    if (resolvedScope === "global" && !user.roles?.includes("chaos-admin")) {
      return reply.code(403).send({ error: "INSUFFICIENT_ROLE" });
    }

    await killSwitchService.disengage(resolvedScope, namespace);

    await db("kill_switch_audit").insert({
      action: "disengage",
      scope: resolvedScope,
      namespace: namespace ?? null,
      reason: "Manually disengaged",
      requested_by: user.sub,
    });

    logger.info({ scope: resolvedScope, requestedBy: user.sub }, "Kill switch disengaged");

    reply.send({ engaged: false, scope: resolvedScope });
  });

  // GET /api/v1/kill-switch
  // Check current kill switch state
  fastify.get("/kill-switch", {
    preHandler: [requireAuth],
  }, async (_request, reply) => {
    const state = await killSwitchService.getState();
    reply.send(state);
  });

  // GET /api/v1/kill-switch/audit
  // Immutable audit log of all kill switch operations
  fastify.get("/kill-switch/audit", {
    preHandler: [requireAuth, requireRole("chaos-operator")],
  }, async (request, reply) => {
    const { limit = 50, offset = 0 } = request.query as {
      limit?: number;
      offset?: number;
    };

    const records = await db("kill_switch_audit")
      .orderBy("created_at", "desc")
      .limit(Math.min(limit, 200))
      .offset(offset);

    reply.send({ records, total: records.length });
  });
}
