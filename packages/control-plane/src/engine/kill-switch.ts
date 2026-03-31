// packages/control-plane/src/engine/kill-switch.ts
// The kill switch is the most critical safety system.
//
// Design requirements:
// 1. Must work even if the control plane is partially down
// 2. Must be visible to ALL chaos engine workers, not just the one that received the HTTP request
// 3. Must be durable — a Redis restart should not silently re-enable chaos
// 4. Must be fast — every chaos action checks it before executing
//
// Implementation: Redis with PERSIST (no TTL on kill switch keys).
// Workers poll Redis directly, bypassing the control plane.
// This means the kill switch works even if the HTTP API is unreachable.

import { createClient, type RedisClientType } from "redis";
import type { KillSwitchState, KillSwitchRequest } from "@chaos/shared-types";
import { logger } from "../observability/logger";
import { natsClient } from "../messaging/nats";

const KILL_SWITCH_KEY = "chaos:killswitch:global";
const NAMESPACE_KILL_KEY = (ns: string) => `chaos:killswitch:ns:${ns}`;
const EXPERIMENT_KILL_KEY = (id: string) => `chaos:killswitch:exp:${id}`;

class KillSwitchService {
  private redis: RedisClientType;
  private stateCache: KillSwitchState | null = null;
  private lastCacheTime = 0;
  private CACHE_TTL_MS = 1000; // 1 second cache — balances freshness vs Redis load

  constructor() {
    this.redis = createClient({
      url: process.env.REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
    }) as RedisClientType;

    this.redis.on("error", (err) => {
      // CRITICAL: If Redis is unavailable, we FAIL SAFE — treat kill switch as engaged.
      // This prevents chaos from running when we can't verify the kill switch state.
      logger.error({ err }, "Redis error in kill switch service — failing safe");
    });

    this.redis.connect().catch((err) => {
      logger.error({ err }, "Failed to connect kill switch Redis");
    });
  }

  async getState(): Promise<KillSwitchState> {
    // Cache state briefly to avoid hammering Redis on every chaos action
    if (this.stateCache && Date.now() - this.lastCacheTime < this.CACHE_TTL_MS) {
      return this.stateCache;
    }

    try {
      const globalRaw = await this.redis.get(KILL_SWITCH_KEY);
      const global = globalRaw ? JSON.parse(globalRaw) : { engaged: false };

      this.stateCache = {
        global: global.engaged ?? false,
        globalReason: global.reason,
        namespaces: {}, // populated on demand
        experiments: {},
        updatedAt: new Date(global.updatedAt ?? Date.now()),
      };

      this.lastCacheTime = Date.now();
      return this.stateCache;
    } catch (err) {
      // Fail safe: Redis unavailable = kill switch engaged
      logger.error({ err }, "Could not read kill switch from Redis, failing safe");
      return {
        global: true,
        globalReason: "Kill switch service unavailable — failing safe",
        namespaces: {},
        experiments: {},
        updatedAt: new Date(),
      };
    }
  }

  async engage(request: KillSwitchRequest, requestedBy: string): Promise<void> {
    const timestamp = new Date();

    if (request.scope === "global") {
      await this.redis.set(
        KILL_SWITCH_KEY,
        JSON.stringify({
          engaged: true,
          reason: request.reason,
          requestedBy,
          updatedAt: timestamp.toISOString(),
        })
      );

      // Broadcast to all workers via NATS — they should stop immediately
      await natsClient.publish("chaos.killswitch.global", {
        engaged: true,
        reason: request.reason,
        requestedBy,
        timestamp,
      });

      logger.warn({ reason: request.reason, requestedBy }, "GLOBAL KILL SWITCH ENGAGED");
    } else if (request.scope === "namespace" && request.namespace) {
      await this.redis.set(
        NAMESPACE_KILL_KEY(request.namespace),
        JSON.stringify({
          engaged: true,
          reason: request.reason,
          requestedBy,
          updatedAt: timestamp.toISOString(),
        })
      );

      logger.warn(
        { namespace: request.namespace, reason: request.reason },
        "Namespace kill switch engaged"
      );
    } else if (request.scope === "experiment" && request.experimentId) {
      await this.redis.set(
        EXPERIMENT_KILL_KEY(request.experimentId),
        JSON.stringify({
          killed: true,
          reason: request.reason,
          requestedBy,
          updatedAt: timestamp.toISOString(),
        })
      );

      await natsClient.publish("chaos.experiment.kill", {
        experimentId: request.experimentId,
        reason: request.reason,
        requestedBy,
      });
    }

    // Invalidate cache immediately
    this.stateCache = null;
  }

  async disengage(scope: "global" | "namespace", namespace?: string): Promise<void> {
    if (scope === "global") {
      await this.redis.set(
        KILL_SWITCH_KEY,
        JSON.stringify({
          engaged: false,
          updatedAt: new Date().toISOString(),
        })
      );

      await natsClient.publish("chaos.killswitch.global", { engaged: false });
      logger.info("Global kill switch disengaged");
    } else if (scope === "namespace" && namespace) {
      await this.redis.del(NAMESPACE_KILL_KEY(namespace));
    }

    this.stateCache = null;
  }

  // Fast path for workers — check a single experiment/namespace
  async isKilled(experimentId: string, namespace?: string): Promise<boolean> {
    const state = await this.getState();
    if (state.global) return true;

    if (namespace) {
      try {
        const nsRaw = await this.redis.get(NAMESPACE_KILL_KEY(namespace));
        if (nsRaw && JSON.parse(nsRaw).engaged) return true;
      } catch {
        return true; // fail safe
      }
    }

    try {
      const expRaw = await this.redis.get(EXPERIMENT_KILL_KEY(experimentId));
      if (expRaw && JSON.parse(expRaw).killed) return true;
    } catch {
      return true;
    }

    return false;
  }
}

export const killSwitchService = new KillSwitchService();
