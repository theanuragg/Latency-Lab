// packages/control-plane/src/api/middleware/auth.ts
// JWT authentication + RBAC middleware for Fastify.
//
// Token structure (JWT payload):
//   sub: string        — user ID
//   email: string      — user email
//   roles: string[]    — chaos-viewer | chaos-operator | chaos-admin
//   iat: number        — issued at
//   exp: number        — expires at
//
// Role hierarchy (additive):
//   chaos-viewer   → read-only: list experiments, metrics, audit log
//   chaos-operator → chaos-viewer + create/kill experiments, namespace kill switch
//   chaos-admin    → chaos-operator + global kill switch, manage schedules, manage RBAC

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";
import { logger } from "../../observability/logger";

export interface JWTPayload {
  sub: string;
  email: string;
  roles: string[];
  iat: number;
  exp: number;
}

// Minimum role required: chaos-viewer (any authenticated user)
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: "UNAUTHORIZED", message: "Valid JWT required" });
  }
}

// Role-based access control — factory returns a middleware for the specified role
export function requireRole(minRole: "chaos-viewer" | "chaos-operator" | "chaos-admin") {
  const hierarchy: Record<string, number> = {
    "chaos-viewer": 1,
    "chaos-operator": 2,
    "chaos-admin": 3,
  };

  return async function roleCheck(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const user = (request as any).user as JWTPayload;
    const userRoles = user?.roles ?? [];

    const userLevel = Math.max(
      0,
      ...userRoles.map((r) => hierarchy[r] ?? 0)
    );
    const requiredLevel = hierarchy[minRole] ?? 99;

    if (userLevel < requiredLevel) {
      logger.warn(
        { userId: user?.sub, userRoles, requiredRole: minRole },
        "RBAC check failed"
      );
      reply.code(403).send({
        error: "FORBIDDEN",
        message: `Role '${minRole}' or higher required`,
        yourRoles: userRoles,
      });
    }
  };
}

// Dev-mode: issue a test token (ONLY enabled when NODE_ENV=development)
// Usage: GET /api/v1/dev-token?role=chaos-admin
export async function devTokenHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (process.env.NODE_ENV !== "development") {
    return reply.code(404).send({ error: "NOT_FOUND" });
  }

  const { role = "chaos-operator" } = request.query as { role?: string };

  const token = await (request.server as any).jwt.sign({
    sub: "dev-user",
    email: "dev@chaos-platform.local",
    roles: [role],
  }, { expiresIn: "24h" });

  reply.send({ token, expiresIn: "24h" });
}
