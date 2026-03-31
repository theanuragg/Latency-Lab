// packages/chaos-engine/src/worker.ts
// Chaos engine worker — subscribes to NATS and executes experiments.
import { connect as natsConnect, StringCodec } from "nats";
import { killSwitchService } from "./engine/kill-switch";
import { PodKillRunner } from "./runners/pod-kill";
import { NetworkChaosRunner } from "./runners/network-chaos";
import { RPCProxyRunner } from "./runners/rpc-proxy-runner";
import { ResourceStressRunner } from "./runners/resource-stress";
import { DependencyChaosRunner } from "./runners/dependency-chaos";
import { NodeDrainRunner } from "./runners/node-drain";
import { HealthChecker } from "./health/checker";
import { MetricsCollector } from "./observability/metrics-collector";
import { experimentRepository } from "./db";
import { chaosEventEmitter } from "./observability/events";
import { logger } from "./logger";
import type { ExperimentConfig, ExperimentType, SelectedTarget, ExperimentEvent } from "@chaos/shared-types";

const runners: Partial<Record<ExperimentType, any>> = {
  "pod-kill": new PodKillRunner(),
  "network-latency": new NetworkChaosRunner("latency"),
  "network-loss": new NetworkChaosRunner("loss"),
  "network-partition": new NetworkChaosRunner("partition"),
  "rpc-timeout": new RPCProxyRunner(),
  "rpc-corrupt": new RPCProxyRunner(),
  "rpc-latency": new RPCProxyRunner(),
  "cpu-stress": new ResourceStressRunner("cpu"),
  "memory-exhaust": new ResourceStressRunner("memory"),
  "disk-throttle": new ResourceStressRunner("disk"),
  "node-drain": new NodeDrainRunner(),
  "dependency-kill": new DependencyChaosRunner(),
};

class ExperimentExecution {
  private aborted = false;
  constructor(
    private readonly experimentId: string,
    private readonly config: ExperimentConfig,
    private readonly requestedBy: string
  ) {}

  async run(): Promise<void> {
    const log = logger.child({ experimentId: this.experimentId, type: this.config.type });
    try {
      await this.updateStatus("running");
      await this.emit("pre-flight", "info", "Starting pre-flight checks");

      if (this.config.safety.requireHealthyBefore) {
        const health = await HealthChecker.check(this.config.safety.healthCheckEndpoints, this.config.target.namespace);
        if (!health.healthy) { await this.abort(`Pre-flight failed: ${health.reason}`); return; }
      }
      await this.emit("pre-flight", "info", "Pre-flight passed");

      const runner = runners[this.config.type];
      if (!runner) throw new Error(`No runner for type: ${this.config.type}`);

      const targets: SelectedTarget[] = await runner.selectTargets(this.config);
      if (targets.length === 0) { await this.abort("No eligible targets found"); return; }

      await experimentRepository.setTargets(this.experimentId, targets);
      await this.emit("execution", "info", `Selected ${targets.length} target(s)`, { targets });

      if (await this.isKilled()) { await this.abort("Kill switch engaged"); return; }

      const baseline = await MetricsCollector.captureSnapshot(this.config.target.namespace, this.experimentId);

      await this.emit("execution", "info", `Injecting ${this.config.type}`);
      await runner.execute(this.config, targets, {
        onAction: async (target: SelectedTarget, action: string) => {
          await this.emit("execution", "info", `${action}: ${target.name}`);
        },
        shouldAbort: async () => this.aborted || (await this.isKilled()),
      });

      await this.monitorDuration(parseDuration(this.config.duration));

      if (this.aborted) { await this.rollback(runner, targets); return; }

      await this.emit("cleanup", "info", "Duration elapsed — cleaning up");
      await runner.cleanup(this.config, targets);

      if (this.config.safety.requireHealthyAfter) {
        await this.emit("cleanup", "info", "Waiting for recovery...");
        const recovered = await HealthChecker.waitForRecovery(
          this.config.safety.healthCheckEndpoints,
          this.config.target.namespace,
          (this.config.safety.recoveryTimeoutSeconds ?? 300) * 1000
        );
        if (!recovered) await this.emit("cleanup", "warn", "System did not recover within timeout");
      }

      const final = await MetricsCollector.captureSnapshot(this.config.target.namespace, this.experimentId);
      const metrics = MetricsCollector.computeMetrics(baseline, final, this.experimentId);
      await experimentRepository.setMetrics(this.experimentId, metrics);
      await this.updateStatus("completed");
      await this.emit("cleanup", "info", `Completed. Chaos score: ${metrics.chaosScore}/100`);
      log.info({ metrics }, "Experiment completed");
    } catch (err: any) {
      log.error({ err }, "Execution error");
      await this.emit("execution", "error", `Error: ${err.message}`);
      await this.updateStatus("failed");
    }
  }

  private async monitorDuration(durationMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      if (await this.isKilled()) { this.aborted = true; return; }
      if (this.config.safety.maxErrorRatePct || this.config.safety.maxLatencyMs) {
        const snap = await MetricsCollector.captureSnapshot(this.config.target.namespace, this.experimentId);
        if (this.config.safety.maxErrorRatePct && snap.errorRate * 100 > this.config.safety.maxErrorRatePct) {
          await this.emit("monitoring", "error", `Error rate ${(snap.errorRate*100).toFixed(1)}% exceeds threshold — auto-rollback`);
          this.aborted = true; return;
        }
        if (this.config.safety.maxLatencyMs && snap.p99LatencyMs > this.config.safety.maxLatencyMs) {
          await this.emit("monitoring", "error", `p99 ${snap.p99LatencyMs}ms exceeds threshold — auto-rollback`);
          this.aborted = true; return;
        }
      }
      await sleep(10_000);
    }
  }

  private async rollback(runner: any, targets: SelectedTarget[]): Promise<void> {
    await this.updateStatus("rolled-back");
    await this.emit("rollback", "warn", "Executing auto-rollback");
    try { await runner.cleanup(this.config, targets); await this.emit("rollback", "info", "Rollback complete"); }
    catch (err: any) { await this.emit("rollback", "error", `Rollback FAILED: ${err.message} — MANUAL INTERVENTION REQUIRED`); }
  }

  private async abort(reason: string): Promise<void> {
    this.aborted = true;
    await this.updateStatus("failed");
    await this.emit("pre-flight", "error", reason);
    await experimentRepository.setRollbackReason(this.experimentId, reason);
  }

  private async isKilled(): Promise<boolean> {
    return killSwitchService.isKilled(this.experimentId, this.config.target.namespace);
  }

  private async updateStatus(status: any): Promise<void> {
    await experimentRepository.updateStatus(this.experimentId, status);
  }

  private async emit(phase: ExperimentEvent["phase"], level: "info"|"warn"|"error", message: string, data?: Record<string, unknown>): Promise<void> {
    await experimentRepository.addEvent(this.experimentId, { timestamp: new Date(), level, phase, message, data });
    await chaosEventEmitter.emit({ experimentId: this.experimentId, experimentName: this.config.name, type: this.config.type, phase: phase as any, timestamp: new Date(), metadata: { message, ...data } });
  }
}

async function main() {
  await chaosEventEmitter.connect();
  const nc = await natsConnect({ servers: process.env.NATS_URL ?? "nats://localhost:4222", reconnect: true, maxReconnectAttempts: -1 });
  const sc = StringCodec();
  const active = new Map<string, ExperimentExecution>();
  const sub = nc.subscribe("chaos.experiment.start");
  (async () => {
    for await (const msg of sub) {
      try {
        const { experimentId, config, requestedBy } = JSON.parse(sc.decode(msg.data));
        const ks = await killSwitchService.getGlobalState();
        if (ks.engaged) { logger.warn({ experimentId }, "Rejected — kill switch engaged"); continue; }
        const ex = new ExperimentExecution(experimentId, config, requestedBy);
        active.set(experimentId, ex);
        ex.run().finally(() => active.delete(experimentId));
      } catch (err) { logger.error({ err }, "Failed to parse start message"); }
    }
  })();
  logger.info({ runners: Object.keys(runners) }, "Chaos engine worker ready");
  process.on("SIGTERM", async () => { await Promise.race([nc.drain(), sleep(30_000)]); process.exit(0); });
}

main().catch(err => { logger.error({ err }, "Fatal error"); process.exit(1); });
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function parseDuration(d: string): number { const u: Record<string,number>={s:1000,m:60000,h:3600000}; const m=d.match(/^(\d+)(s|m|h)$/); if(!m) throw new Error(`Invalid duration: ${d}`); return parseInt(m[1])*u[m[2]]; }
