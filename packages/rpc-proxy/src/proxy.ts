// packages/rpc-proxy/src/proxy.ts
// The RPC chaos proxy sits in front of real RPC endpoints (Solana nodes, etc.)
// and injects configurable failures into the request/response path.
//
// Architecture:
// ┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐
// │   Client    │───▶│  RPC Chaos Proxy │───▶│  Real RPC Node  │
// └─────────────┘    └──────────────────┘    └─────────────────┘
//                           │
//                    ┌──────┴───────┐
//                    │ Failure modes│
//                    │ · latency    │
//                    │ · timeout    │
//                    │ · corrupt    │
//                    │ · drop       │
//                    └─────────────┘
//
// Deployment: Kubernetes sidecar OR standalone deployment.
// For Solana: deploy between your validator/RPC aggregator and downstream consumers.
//
// The proxy is stateless and reads its config from Redis every N ms,
// so config changes take effect without restarting the proxy.

import Fastify from "fastify";
import { createClient } from "redis";
import { logger } from "./logger";

interface ProxyConfig {
  targetUrl: string;
  port: number;
  redisUrl: string;
}

interface ChaosConfig {
  enabled: boolean;
  errorRate: number; // 0-1: probability of triggering a fault
  latencyMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  corruptionMode?: "invalid-json" | "truncate" | "wrong-method" | "connection-refused";
  dropMode?: boolean; // silently drop request
}

const CHAOS_CONFIG_KEY = (proxyId: string) => `chaos:rpc-proxy:${proxyId}:config`;

class RPCChaosProxy {
  private server = Fastify({ logger: false });
  private redis = createClient({ url: this.config.redisUrl }) as any;
  private chaosConfig: ChaosConfig = { enabled: false, errorRate: 0 };
  private lastConfigFetch = 0;
  private CONFIG_TTL_MS = 1000;
  private readonly proxyId: string;

  constructor(private readonly config: ProxyConfig) {
    this.proxyId = process.env.PROXY_ID ?? "default";
  }

  async start() {
    await this.redis.connect();
    this.setupRoutes();

    await this.server.listen({ port: this.config.port, host: "0.0.0.0" });
    logger.info({ port: this.config.port, target: this.config.targetUrl }, "RPC chaos proxy started");
  }

  private setupRoutes() {
    // Catch-all: proxy everything to the target, with chaos injection
    this.server.all("/*", async (request, reply) => {
      const chaosConfig = await this.getChaosConfig();

      // Fast path — no chaos active, just proxy
      if (!chaosConfig.enabled || Math.random() > chaosConfig.errorRate) {
        return this.forwardRequest(request, reply);
      }

      // Chaos path — pick a fault
      return this.injectFault(request, reply, chaosConfig);
    });
  }

  private async injectFault(request: any, reply: any, chaos: ChaosConfig) {
    const faultType = this.selectFaultType(chaos);
    logger.info({ faultType, method: request.method, url: request.url }, "Injecting RPC fault");

    switch (faultType) {
      case "drop":
        // Silent drop — client hangs until their own timeout
        // Do NOT reply — let the connection hang
        await sleep(60_000); // hang for 60s (client will timeout first)
        break;

      case "connection-refused":
        // Immediately close the connection
        reply.raw.socket?.destroy();
        break;

      case "timeout":
        // Wait longer than any reasonable timeout, then close
        await sleep(chaos.timeoutMs ?? 30_000);
        reply.code(504).send({ error: "Gateway Timeout (chaos injected)" });
        break;

      case "latency":
        // Inject latency but still forward the request
        const latency = (chaos.latencyMs ?? 100) + jitter(chaos.jitterMs ?? 0);
        await sleep(latency);
        return this.forwardRequest(request, reply);

      case "invalid-json":
        reply
          .code(200)
          .header("content-type", "application/json")
          .send("{ this is not valid json ]]]{{");
        break;

      case "truncate":
        // Return valid JSON for the start but truncate mid-response
        // This tests whether clients handle incomplete JSON gracefully
        reply
          .code(200)
          .header("content-type", "application/json")
          .send('{"jsonrpc":"2.0","id":1,"result":{"truncate');
        break;

      case "wrong-method":
        // Return a valid JSON-RPC response but for the wrong method
        // Tests method ID validation in clients
        const wrongResponse = {
          jsonrpc: "2.0",
          id: (request.body as any)?.id ?? 1,
          result: { __chaos: "wrong_method_response", originalMethod: (request.body as any)?.method },
        };
        reply.code(200).send(wrongResponse);
        break;

      default:
        return this.forwardRequest(request, reply);
    }
  }

  private async forwardRequest(request: any, reply: any): Promise<void> {
    try {
      const targetUrl = `${this.config.targetUrl}${request.url}`;

      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          ...request.headers,
          host: new URL(this.config.targetUrl).host,
          // Remove proxy-specific headers
          "x-forwarded-for": undefined as any,
        },
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? JSON.stringify(request.body)
            : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      const responseBody = await response.text();

      reply
        .code(response.status)
        .headers(Object.fromEntries(response.headers.entries()))
        .send(responseBody);
    } catch (err: any) {
      logger.error({ err }, "Proxy forward error");
      reply.code(502).send({ error: "Bad Gateway", message: err.message });
    }
  }

  private selectFaultType(chaos: ChaosConfig): string {
    if (chaos.dropMode) return "drop";
    if (chaos.corruptionMode) return chaos.corruptionMode;
    if (chaos.timeoutMs) return "timeout";
    if (chaos.latencyMs) return "latency";
    return "latency"; // default
  }

  private async getChaosConfig(): Promise<ChaosConfig> {
    if (Date.now() - this.lastConfigFetch < this.CONFIG_TTL_MS) {
      return this.chaosConfig;
    }

    try {
      const raw = await this.redis.get(CHAOS_CONFIG_KEY(this.proxyId));
      if (raw) {
        this.chaosConfig = JSON.parse(raw);
      } else {
        this.chaosConfig = { enabled: false, errorRate: 0 };
      }
    } catch {
      // Redis unavailable → disable chaos (fail safe in the OTHER direction here —
      // for the proxy, "safe" means passing traffic, not blocking it)
      this.chaosConfig = { enabled: false, errorRate: 0 };
    }

    this.lastConfigFetch = Date.now();
    return this.chaosConfig;
  }

  // Called by the chaos engine runner to configure this proxy
  static async setChaosConfig(
    redis: any,
    proxyId: string,
    config: ChaosConfig
  ): Promise<void> {
    await redis.set(
      CHAOS_CONFIG_KEY(proxyId),
      JSON.stringify(config),
      { EX: 7200 } // 2 hour TTL — experiments don't last longer than this
    );
  }

  static async clearChaosConfig(redis: any, proxyId: string): Promise<void> {
    await redis.set(
      CHAOS_CONFIG_KEY(proxyId),
      JSON.stringify({ enabled: false, errorRate: 0 })
    );
  }
}

// ─── Runner that configures the proxy ─────────────────────────────────────────

export class RPCProxyRunner {
  private redis: any;

  constructor() {
    this.redis = createClient({ url: process.env.REDIS_URL });
    this.redis.connect().catch(logger.error);
  }

  async selectTargets(config: any) {
    return (config.target.rpcEndpoints ?? []).map((ep: string) => ({
      kind: "rpc-endpoint" as const,
      name: ep,
    }));
  }

  async execute(config: any, _targets: any[], callbacks: any): Promise<void> {
    const action = config.action;

    const chaosConfig: ChaosConfig = {
      enabled: true,
      errorRate: action.errorRate ?? 0.5,
      latencyMs: action.latencyMs,
      jitterMs: action.jitterMs,
      timeoutMs: action.timeoutMs,
      corruptionMode: action.corruptionMode,
    };

    // Find all proxy instances for this experiment's target endpoints
    // In production, proxy IDs are stored in a service registry
    const proxyIds = await this.resolveProxyIds(config.target.rpcEndpoints ?? []);

    for (const proxyId of proxyIds) {
      await RPCChaosProxy.setChaosConfig(this.redis, proxyId, chaosConfig);
      await callbacks.onAction({ name: proxyId, kind: "rpc-endpoint" }, `RPC chaos config applied`);
    }
  }

  async cleanup(config: any, _targets: any[]): Promise<void> {
    const proxyIds = await this.resolveProxyIds(config.target.rpcEndpoints ?? []);

    for (const proxyId of proxyIds) {
      await RPCChaosProxy.clearChaosConfig(this.redis, proxyId);
    }

    logger.info("RPC proxy chaos config cleared");
  }

  private async resolveProxyIds(endpoints: string[]): Promise<string[]> {
    // In production: look up proxy IDs from your service registry
    // For now: derive proxy ID from endpoint URL
    return endpoints.map((ep) =>
      ep.replace(/[^a-z0-9]/g, "-").toLowerCase()
    );
  }
}

// ─── Standalone entry point ───────────────────────────────────────────────────

if (require.main === module) {
  const proxy = new RPCChaosProxy({
    targetUrl: process.env.TARGET_URL ?? "http://localhost:8899",
    port: parseInt(process.env.PORT ?? "9090"),
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  });

  proxy.start().catch((err) => {
    logger.error({ err }, "Failed to start RPC proxy");
    process.exit(1);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(maxMs: number): number {
  return Math.random() * maxMs;
}

export { RPCChaosProxy };
