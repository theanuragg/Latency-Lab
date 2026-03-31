// packages/chaos-engine/src/engine/kill-switch.ts
// The engine's kill switch client reads Redis directly.
// This is intentionally a standalone Redis client — the engine must NOT
// depend on the control plane being reachable to honour kill signals.

import { createClient, type RedisClientType } from "redis";
import { logger } from "../logger";

const KILL_SWITCH_KEY = "chaos:killswitch:global";
const NAMESPACE_KILL_KEY = (ns: string) => `chaos:killswitch:ns:${ns}`;
const EXPERIMENT_KILL_KEY = (id: string) => `chaos:killswitch:exp:${id}`;

class EngineKillSwitchClient {
  private redis: RedisClientType;
  private cache: { global: boolean; ts: number } = { global: false, ts: 0 };
  private TTL = 1000; // 1s cache

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL }) as RedisClientType;
    this.redis.on("error", () => {
      // If Redis is down, treat kill switch as engaged (fail safe)
      this.cache = { global: true, ts: Date.now() };
    });
    this.redis.connect().catch((err) =>
      logger.error({ err }, "Engine kill switch Redis connect failed")
    );
  }

  async isKilled(experimentId: string, namespace?: string): Promise<boolean> {
    // Check cache for global switch
    if (Date.now() - this.cache.ts < this.TTL) {
      if (this.cache.global) return true;
    } else {
      try {
        const raw = await this.redis.get(KILL_SWITCH_KEY);
        const global = raw ? JSON.parse(raw).engaged ?? false : false;
        this.cache = { global, ts: Date.now() };
        if (global) return true;
      } catch {
        return true; // fail safe
      }
    }

    // Check namespace
    if (namespace) {
      try {
        const raw = await this.redis.get(NAMESPACE_KILL_KEY(namespace));
        if (raw && JSON.parse(raw).engaged) return true;
      } catch {
        return true;
      }
    }

    // Check experiment-level
    try {
      const raw = await this.redis.get(EXPERIMENT_KILL_KEY(experimentId));
      if (raw && JSON.parse(raw).killed) return true;
    } catch {
      return true;
    }

    return false;
  }

  async getGlobalState(): Promise<{ engaged: boolean; reason?: string }> {
    try {
      const raw = await this.redis.get(KILL_SWITCH_KEY);
      return raw ? JSON.parse(raw) : { engaged: false };
    } catch {
      return { engaged: true, reason: "Redis unavailable" };
    }
  }
}

export const killSwitchService = new EngineKillSwitchClient();
