// packages/chaos-engine/src/runners/rpc-proxy-runner.ts
// Engine-side runner — configures the RPC chaos proxy via Redis.
// The proxy itself is in packages/rpc-proxy/src/proxy.ts.

import { createClient } from "redis";
import type { ExperimentConfig, SelectedTarget } from "@chaos/shared-types";
import { logger } from "../logger";

const CHAOS_CONFIG_KEY = (proxyId: string) => `chaos:rpc-proxy:${proxyId}:config`;

export class RPCProxyRunner {
  private redis: any;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL });
    this.redis.connect().catch((err: any) =>
      logger.error({ err }, "RPCProxyRunner: Redis connect failed")
    );
  }

  async selectTargets(config: ExperimentConfig): Promise<SelectedTarget[]> {
    return (config.target.rpcEndpoints ?? []).map((ep) => ({
      kind: "rpc-endpoint" as const,
      name: ep,
    }));
  }

  async execute(config: ExperimentConfig, targets: SelectedTarget[], callbacks: any): Promise<void> {
    const action = config.action as any;

    const chaosConfig = {
      enabled: true,
      errorRate: action.errorRate ?? 0.5,
      latencyMs: action.latencyMs,
      jitterMs: action.jitterMs,
      timeoutMs: action.timeoutMs,
      corruptionMode: action.corruptionMode,
      dropMode: action.corruptionMode === "connection-refused",
    };

    for (const target of targets) {
      const proxyId = this.endpointToProxyId(target.name);
      await this.redis.set(
        CHAOS_CONFIG_KEY(proxyId),
        JSON.stringify(chaosConfig),
        { EX: 7200 }
      );
      await callbacks.onAction(target, `RPC chaos applied (mode: ${action.corruptionMode ?? "latency"})`);
      logger.info({ proxyId, config: chaosConfig }, "RPC proxy configured");
    }
  }

  async cleanup(config: ExperimentConfig, targets: SelectedTarget[]): Promise<void> {
    for (const target of targets) {
      const proxyId = this.endpointToProxyId(target.name);
      await this.redis.set(
        CHAOS_CONFIG_KEY(proxyId),
        JSON.stringify({ enabled: false, errorRate: 0 }),
        { EX: 3600 }
      );
    }
    logger.info("RPC proxy chaos cleared");
  }

  private endpointToProxyId(endpoint: string): string {
    return endpoint.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  }
}
