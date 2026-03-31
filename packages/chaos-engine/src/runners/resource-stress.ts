// packages/chaos-engine/src/runners/resource-stress.ts
// Resource chaos injects CPU, memory, and disk I/O pressure into pods.
//
// Implementation: We exec stress-ng inside the target pod.
// stress-ng is the industry standard for resource stress testing:
//   - CPU: spawns workers that compute sqrt() in a tight loop
//   - Memory: allocates and touches memory pages to force swapping
//   - Disk: sequential write/read at configurable throughput
//
// Why exec rather than sidecar injection?
// Exec is simpler for one-off experiments. For continuous chaos,
// a sidecar is better because exec sessions die with the API connection.
//
// Pre-requisite: stress-ng must be installed in the target container.
// For production: inject a stress-ng sidecar or use a node-level agent.

import * as k8s from "@kubernetes/client-node";
import type { ExperimentConfig, SelectedTarget } from "@chaos/shared-types";
import { logger } from "../logger";

type StressMode = "cpu" | "memory" | "disk";

interface StressProcess {
  target: SelectedTarget;
  pid?: number; // PID of stress-ng inside the container
  cleanup: () => Promise<void>;
}

export class ResourceStressRunner {
  private k8sApi: k8s.CoreV1Api;
  private activeProcesses: Map<string, StressProcess> = new Map();

  constructor(private readonly mode: StressMode) {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  async selectTargets(config: ExperimentConfig): Promise<SelectedTarget[]> {
    const labelSelectorStr = config.target.labelSelector
      ? Object.entries(config.target.labelSelector).map(([k, v]) => `${k}=${v}`).join(",")
      : undefined;

    const response = await this.k8sApi.listNamespacedPod({
      namespace: config.target.namespace ?? "default",
      labelSelector: labelSelectorStr,
      fieldSelector: "status.phase=Running",
    });

    const pods = response.items;
    const maxTargets = Math.floor(
      (config.blastRadius.value / 100) * pods.length
    );

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
    const durationMs = parseDuration(config.duration);

    for (const target of targets) {
      if (await callbacks.shouldAbort()) break;

      const command = this.buildStressCommand(action, durationMs);

      try {
        // Run stress-ng in background (don't await — it runs for the duration)
        const cleanup = await this.startStress(target, command);
        this.activeProcesses.set(target.name, { target, cleanup });
        await callbacks.onAction(target, `${this.mode} stress started`);

        logger.info(
          { pod: target.name, command, mode: this.mode },
          "Resource stress started"
        );
      } catch (err: any) {
        logger.error(
          { err, pod: target.name },
          "Failed to start stress — is stress-ng installed in the container?"
        );
        await callbacks.onAction(target, `FAILED: ${err.message}`);
      }
    }
  }

  async cleanup(_config: ExperimentConfig, targets: SelectedTarget[]): Promise<void> {
    for (const target of targets) {
      const process = this.activeProcesses.get(target.name);
      if (process) {
        await process.cleanup();
        this.activeProcesses.delete(target.name);
      }
    }

    logger.info({ mode: this.mode }, "Resource stress cleaned up");
  }

  private buildStressCommand(action: any, durationMs: number): string[] {
    const durationSec = Math.ceil(durationMs / 1000);

    switch (this.mode) {
      case "cpu": {
        const workers = action.workers ?? 1;
        const loadPct = action.cpuLoadPercent ?? 80;
        // stress-ng --cpu N: N workers computing sqrt
        // --cpu-load P: target P% CPU utilization (requires --cpu)
        return [
          "stress-ng",
          "--cpu", String(workers),
          "--cpu-load", String(loadPct),
          "--timeout", `${durationSec}s`,
          "--metrics-brief",
        ];
      }

      case "memory": {
        const bytes = action.memoryBytes ?? 256 * 1024 * 1024; // 256 MiB default
        const workers = action.workers ?? 1;
        // --vm N: N workers allocating memory
        // --vm-bytes S: memory per worker
        // --vm-keep: don't free memory between allocations (more realistic)
        return [
          "stress-ng",
          "--vm", String(workers),
          "--vm-bytes", String(bytes),
          "--vm-keep",
          "--timeout", `${durationSec}s`,
          "--metrics-brief",
        ];
      }

      case "disk": {
        const writeBps = action.diskWriteBps ?? 10 * 1024 * 1024; // 10 MiB/s default
        const workers = action.workers ?? 1;
        // --hdd N: N workers doing sequential disk I/O
        // --hdd-write-size: write block size
        // The actual throughput is limited by the underlying storage
        return [
          "stress-ng",
          "--hdd", String(workers),
          "--hdd-write-size", "1m",
          "--timeout", `${durationSec}s`,
          "--metrics-brief",
          "--temp-path", "/tmp",
        ];
      }
    }
  }

  private async startStress(
    target: SelectedTarget,
    command: string[]
  ): Promise<() => Promise<void>> {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    const exec = new k8s.Exec(kc);

    // Start stress-ng in background within the pod
    // We run it in a subshell so we can capture the PID for cleanup
    const bgCommand = [
      "sh", "-c",
      `${command.join(" ")} & echo $!`,
    ];

    let pid: number | undefined;

    await new Promise<void>((resolve, reject) => {
      exec.exec(
        target.namespace!,
        target.name,
        "app",
        bgCommand,
        {
          write: (data: Buffer) => {
            const output = data.toString().trim();
            const parsedPid = parseInt(output);
            if (!isNaN(parsedPid)) {
              pid = parsedPid;
            }
          },
        } as any,
        null,
        null,
        false,
        (status) => {
          if (status.status === "Success") resolve();
          else reject(new Error(`exec failed: ${JSON.stringify(status)}`));
        }
      );
    });

    // Return a cleanup function that kills the stress process
    return async () => {
      if (pid) {
        try {
          await new Promise<void>((resolve) => {
            exec.exec(
              target.namespace!,
              target.name,
              "app",
              ["kill", "-TERM", String(pid)],
              null,
              null,
              null,
              false,
              () => resolve()
            );
          });
          logger.info({ pod: target.name, pid }, "Stress process terminated");
        } catch (err) {
          // Process may have already exited (if duration elapsed)
          logger.debug({ err, pod: target.name }, "Stress cleanup (process may have exited)");
        }
      }
    };
  }
}

function parseDuration(d: string): number {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
  const m = d.match(/^(\d+)(s|m|h)$/);
  if (!m) throw new Error(`Invalid duration: ${d}`);
  return parseInt(m[1]) * units[m[2]];
}
