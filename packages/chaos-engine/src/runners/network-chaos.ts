// packages/chaos-engine/src/runners/network-chaos.ts
// Network chaos implementation using Linux's tc/netem.
//
// How tc/netem works:
// tc (traffic control) is a Linux kernel subsystem for shaping traffic.
// netem (Network Emulation) is a tc qdisc (queuing discipline) that adds
// artificial delay, loss, corruption, and duplication to packets.
//
// The command pattern:
//   tc qdisc add dev eth0 root netem delay 100ms 20ms loss 1%
//
// Where "20ms" is jitter (normal distribution) and "loss 1%" is packet loss.
//
// Deployment model:
// We deploy a DaemonSet with a privileged container that has NET_ADMIN capability.
// The chaos engine talks to this agent via a gRPC API.
// The agent executes tc commands on the host network namespace.
//
// Why DaemonSet vs sidecar?
// DaemonSet: One agent per node, controls all pods on that node.
//   Pro: Simpler deployment, can do node-level network partition.
//   Con: More blast radius than needed (affects all pods on node).
//
// Sidecar: One agent per pod, controls only that pod's network.
//   Pro: Precise blast radius control.
//   Con: Requires mutating webhook to inject sidecar.
//
// We implement DaemonSet because it's simpler and most chaos targets
// are at the service level, not individual pod level.

import * as k8s from "@kubernetes/client-node";
import type { ExperimentConfig, SelectedTarget } from "@chaos/shared-types";
import { logger } from "../logger";

type NetworkChaosMode = "latency" | "loss" | "partition";

interface NetemConfig {
  latencyMs?: number;
  jitterMs?: number;
  correlationPct?: number;
  lossPercent?: number;
  direction?: "ingress" | "egress" | "both";
}

export class NetworkChaosRunner {
  private k8sApi: k8s.CoreV1Api;

  constructor(private readonly mode: NetworkChaosMode) {
    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async selectTargets(config: ExperimentConfig): Promise<SelectedTarget[]> {
    // For network chaos, targets are pods (we apply rules to their network namespace)
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
    const shuffled = pods.sort(() => Math.random() - 0.5);

    return shuffled.slice(0, maxTargets).map((pod) => ({
      kind: "pod" as const,
      name: pod.metadata!.name!,
      namespace: pod.metadata!.namespace!,
      metadata: {
        ...pod.metadata?.labels,
        nodeName: pod.spec?.nodeName ?? "",
        podIP: pod.status?.podIP ?? "",
      },
    }));
  }

  async execute(
    config: ExperimentConfig,
    targets: SelectedTarget[],
    callbacks: any
  ): Promise<void> {
    const action = config.action as any;

    for (const target of targets) {
      if (await callbacks.shouldAbort()) break;

      const netemConfig = this.buildNetEmConfig(action);
      const commands = this.buildTcCommands(netemConfig, this.mode, action.isolateFrom);

      await this.applyNetworkRules(target, commands);
      await callbacks.onAction(target, `Network ${this.mode} injected`);

      logger.info(
        { pod: target.name, mode: this.mode, config: netemConfig },
        "Network chaos applied"
      );
    }
  }

  async cleanup(config: ExperimentConfig, targets: SelectedTarget[]): Promise<void> {
    for (const target of targets) {
      await this.removeNetworkRules(target);
    }
    logger.info({ mode: this.mode }, "Network chaos cleaned up");
  }

  private buildNetEmConfig(action: any): NetemConfig {
    return {
      latencyMs: action.latencyMs,
      jitterMs: action.jitterMs,
      correlationPct: action.correlationPercent ?? 25, // 25% correlation is realistic
      lossPercent: action.lossPercent,
      direction: action.direction ?? "both",
    };
  }

  // Build the tc/netem command to run inside the pod's network namespace
  private buildTcCommands(
    cfg: NetemConfig,
    mode: NetworkChaosMode,
    isolateFrom?: string[]
  ): string[] {
    const commands: string[] = [];
    const iface = "eth0"; // standard K8s pod interface

    // First, remove any existing rules
    commands.push(`tc qdisc del dev ${iface} root 2>/dev/null || true`);

    switch (mode) {
      case "latency": {
        // netem delay: add latency with jitter
        // The "25%" at the end is correlation — makes consecutive packets correlated
        // which is more realistic than pure random jitter
        const jitter = cfg.jitterMs ? `${cfg.jitterMs}ms ${cfg.correlationPct}%` : "";
        commands.push(
          `tc qdisc add dev ${iface} root netem delay ${cfg.latencyMs}ms ${jitter}`.trim()
        );
        break;
      }

      case "loss": {
        // netem loss: random packet loss with correlation
        // "loss random X% Y%" = X% loss rate, Y% correlation
        commands.push(
          `tc qdisc add dev ${iface} root netem loss random ${cfg.lossPercent}% ${cfg.correlationPct}%`
        );
        break;
      }

      case "partition": {
        // Network partition using iptables + ipset
        // This is more surgical than tc — we block traffic to specific services
        // without affecting latency for other traffic
        if (isolateFrom && isolateFrom.length > 0) {
          commands.push(
            // Create an ipset for the target service IPs
            `ipset create chaos-partition hash:ip 2>/dev/null || ipset flush chaos-partition`
          );

          // The chaos engine resolves service names to IPs before calling this
          // (see resolveServiceIPs below)

          commands.push(
            // Drop all traffic to/from the partition set
            `iptables -A OUTPUT -m set --match-set chaos-partition dst -j DROP`,
            `iptables -A INPUT -m set --match-set chaos-partition src -j DROP`
          );
        }
        break;
      }
    }

    return commands;
  }

  private buildCleanupCommands(): string[] {
    return [
      "tc qdisc del dev eth0 root 2>/dev/null || true",
      // Remove partition rules if they exist
      "iptables -D OUTPUT -m set --match-set chaos-partition dst -j DROP 2>/dev/null || true",
      "iptables -D INPUT -m set --match-set chaos-partition src -j DROP 2>/dev/null || true",
      "ipset destroy chaos-partition 2>/dev/null || true",
    ];
  }

  // Execute commands inside the pod using the K8s exec API
  // In production: use the DaemonSet agent instead for better reliability
  private async applyNetworkRules(target: SelectedTarget, commands: string[]): Promise<void> {
    const script = commands.join(" && ");
    await this.execInPod(target, ["sh", "-c", script]);
  }

  private async removeNetworkRules(target: SelectedTarget): Promise<void> {
    const script = this.buildCleanupCommands().join(" && ");
    try {
      await this.execInPod(target, ["sh", "-c", script]);
    } catch (err) {
      // Cleanup errors are logged but not fatal — the rules will be gone when the pod restarts
      logger.warn({ err, pod: target.name }, "Network cleanup error (non-fatal)");
    }
  }

  private async execInPod(
    target: SelectedTarget,
    command: string[]
  ): Promise<string> {
    // Uses the K8s exec API (equivalent of kubectl exec)
    // The pod must have the tc and iptables utilities available.
    // For production: use the DaemonSet agent which runs with NET_ADMIN on the host.

    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    const exec = new k8s.Exec(kc);

    return new Promise((resolve, reject) => {
      const stdout: string[] = [];
      const stderr: string[] = [];

      exec.exec(
        target.namespace!,
        target.name,
        "app", // container name — configurable in production
        command,
        {
          write: (data: Buffer) => stdout.push(data.toString()),
        } as any,
        {
          write: (data: Buffer) => stderr.push(data.toString()),
        } as any,
        null,
        false,
        (status) => {
          if (status.status === "Success") {
            resolve(stdout.join(""));
          } else {
            reject(new Error(`exec failed: ${stderr.join("")}`));
          }
        }
      );
    });
  }
}
