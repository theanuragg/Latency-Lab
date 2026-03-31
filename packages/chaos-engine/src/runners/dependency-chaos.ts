// packages/chaos-engine/src/runners/dependency-chaos.ts
// Dependency chaos simulates downstream service failures:
// databases going offline, Redis evicting all keys, external APIs timing out.
//
// Implementation: iptables rules block TCP traffic to the target IP:port.
// This is more realistic than killing the service itself — it tests
// whether your connection pooling, circuit breakers, and retry logic work.
//
// Common findings:
//   - Connection pools don't have acquisition timeouts → thread pool exhaustion
//   - No circuit breaker → every request hangs until DB timeout (30s default)
//   - No fallback → 100% error rate instead of degraded mode

import * as k8s from "@kubernetes/client-node";
import type { ExperimentConfig, SelectedTarget } from "@chaos/shared-types";
import { logger } from "../logger";

interface DependencyTarget {
  host: string;
  port: number;
  serviceName: string;
}

export class DependencyChaosRunner {
  private k8sApi: k8s.CoreV1Api;

  constructor() {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async selectTargets(config: ExperimentConfig): Promise<SelectedTarget[]> {
    const action = config.action as any;

    // Targets are the pods that will have their outbound connections blocked,
    // not the dependency itself
    const labelSelectorStr = config.target.labelSelector
      ? Object.entries(config.target.labelSelector).map(([k, v]) => `${k}=${v}`).join(",")
      : undefined;

    const response = await this.k8sApi.listNamespacedPod({
      namespace: config.target.namespace ?? "default",
      labelSelector: labelSelectorStr,
      fieldSelector: "status.phase=Running",
    });

    const pods = response.items;
    const maxTargets = Math.floor((config.blastRadius.value / 100) * pods.length);

    return pods
      .sort(() => Math.random() - 0.5)
      .slice(0, maxTargets)
      .map((pod) => ({
        kind: "pod" as const,
        name: pod.metadata!.name!,
        namespace: pod.metadata!.namespace!,
        metadata: pod.metadata?.labels,
      }));
  }

  async execute(
    config: ExperimentConfig,
    targets: SelectedTarget[],
    callbacks: any
  ): Promise<void> {
    const action = config.action as any;
    const depTarget = await this.resolveDependencyTarget(action);

    for (const target of targets) {
      if (await callbacks.shouldAbort()) break;

      const blockCmd = this.buildBlockCommand(depTarget, action.blockMode);

      try {
        await this.execInPod(target, ["sh", "-c", blockCmd]);
        await callbacks.onAction(
          target,
          `${action.target} blocked (${action.blockMode})`
        );
        logger.info(
          { pod: target.name, dependency: action.target, mode: action.blockMode },
          "Dependency chaos applied"
        );
      } catch (err: any) {
        logger.error({ err, pod: target.name }, "Failed to apply dependency chaos");
        await callbacks.onAction(target, `FAILED: ${err.message}`);
      }
    }
  }

  async cleanup(config: ExperimentConfig, targets: SelectedTarget[]): Promise<void> {
    const action = config.action as any;
    const depTarget = await this.resolveDependencyTarget(action);

    for (const target of targets) {
      const unblockCmd = this.buildUnblockCommand(depTarget);
      try {
        await this.execInPod(target, ["sh", "-c", unblockCmd]);
      } catch (err) {
        logger.warn({ err, pod: target.name }, "Dependency cleanup error (non-fatal)");
      }
    }

    logger.info({ dependency: action.target }, "Dependency chaos cleaned up");
  }

  private async resolveDependencyTarget(action: any): Promise<DependencyTarget> {
    // Resolve well-known dependency names to host:port
    const wellKnown: Record<string, DependencyTarget> = {
      redis: { host: process.env.REDIS_HOST ?? "redis", port: 6379, serviceName: "redis" },
      postgres: { host: process.env.PG_HOST ?? "postgres", port: 5432, serviceName: "postgres" },
      kafka: { host: process.env.KAFKA_HOST ?? "kafka", port: 9092, serviceName: "kafka" },
    };

    if (action.target in wellKnown) return wellKnown[action.target];

    if (action.customEndpoint) {
      const [host, portStr] = action.customEndpoint.split(":");
      return { host, port: parseInt(portStr ?? "80"), serviceName: action.customEndpoint };
    }

    throw new Error(`Unknown dependency target: ${action.target}`);
  }

  private buildBlockCommand(dep: DependencyTarget, mode: string): string {
    switch (mode) {
      case "drop":
        // DROP silently discards packets — simulates network black hole
        return `iptables -A OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j DROP`;
      case "refuse":
        // REJECT immediately returns RST — simulates port closed
        return `iptables -A OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j REJECT --reject-with tcp-reset`;
      case "timeout":
        // DROP + mark with NFQUEUE simulates connection timeout
        // For simplicity we use DROP which achieves the same client-side effect
        return `iptables -A OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j DROP`;
      default:
        return `iptables -A OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j DROP`;
    }
  }

  private buildUnblockCommand(dep: DependencyTarget): string {
    // Remove all OUTPUT rules for this target
    return [
      `iptables -D OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j DROP 2>/dev/null || true`,
      `iptables -D OUTPUT -d ${dep.host} -p tcp --dport ${dep.port} -j REJECT --reject-with tcp-reset 2>/dev/null || true`,
    ].join(" && ");
  }

  private async execInPod(target: SelectedTarget, command: string[]): Promise<void> {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    const exec = new k8s.Exec(kc);

    return new Promise((resolve, reject) => {
      const stderr: string[] = [];
      exec.exec(
        target.namespace!,
        target.name,
        "app",
        command,
        null,
        { write: (d: Buffer) => stderr.push(d.toString()) } as any,
        null,
        false,
        (status) => {
          if (status.status === "Success") resolve();
          else reject(new Error(stderr.join("") || JSON.stringify(status)));
        }
      );
    });
  }
}
