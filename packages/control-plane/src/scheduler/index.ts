// packages/control-plane/src/scheduler/index.ts
// The experiment scheduler manages recurring chaos experiments.
//
// Design: We use node-cron as the scheduler engine, but store all schedule
// state in PostgreSQL. This means:
//   - Schedules survive control plane restarts
//   - Multiple control plane replicas don't double-fire (via advisory locks)
//   - We have a full history of when experiments ran
//
// The scheduler uses PostgreSQL advisory locks to ensure only one control
// plane instance fires a given scheduled experiment when running HA.

import cron from "node-cron";
import { db } from "../db";
import { natsClient } from "../messaging/nats";
import { policyEngine } from "../policy/engine";
import { killSwitchService } from "../engine/kill-switch";
import { logger } from "../observability/logger";
import type { ExperimentConfig } from "@chaos/shared-types";
import { randomUUID } from "crypto";

interface ScheduledExperiment {
  id: string;
  experimentConfig: ExperimentConfig;
  cronExpression: string;
  enabled: boolean;
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdBy: string;
}

export class ChaosScheduler {
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load all enabled schedules from DB on startup
    const schedules = await db("scheduled_experiments").where({ enabled: true });

    for (const schedule of schedules) {
      await this.registerJob(schedule);
    }

    this.initialized = true;
    logger.info({ count: schedules.length }, "Chaos scheduler initialized");
  }

  async schedule(experimentId: string, cronExpression: string): Promise<void> {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: '${cronExpression}'`);
    }

    const experiment = await db("experiments").where({ id: experimentId }).first();
    if (!experiment) throw new Error(`Experiment ${experimentId} not found`);

    const scheduleId = randomUUID();

    await db("scheduled_experiments").insert({
      id: scheduleId,
      experiment_config: JSON.stringify(experiment.config),
      cron_expression: cronExpression,
      enabled: true,
      created_by: experiment.created_by,
    });

    await this.registerJob({
      id: scheduleId,
      experiment_config: experiment.config,
      cron_expression: cronExpression,
      enabled: true,
      created_by: experiment.created_by,
    });

    logger.info({ scheduleId, cronExpression }, "Experiment scheduled");
  }

  private async registerJob(schedule: any): Promise<void> {
    const existing = this.jobs.get(schedule.id);
    if (existing) {
      existing.stop();
    }

    const task = cron.schedule(
      schedule.cron_expression,
      async () => {
        await this.fireScheduledExperiment(schedule);
      },
      {
        timezone: "UTC",
        runOnInit: false,
      }
    );

    this.jobs.set(schedule.id, task);
    logger.debug({ scheduleId: schedule.id, cron: schedule.cron_expression }, "Job registered");
  }

  private async fireScheduledExperiment(schedule: any): Promise<void> {
    const log = logger.child({ scheduleId: schedule.id });

    // Use PostgreSQL advisory lock to prevent double-firing in HA deployments
    // The lock ID is derived from the schedule ID (hash to integer)
    const lockId = hashToInt(schedule.id);
    const acquired = await db.raw(`SELECT pg_try_advisory_lock(?)`, [lockId]);

    if (!acquired.rows[0].pg_try_advisory_lock) {
      log.debug("Another instance is handling this schedule, skipping");
      return;
    }

    try {
      // Check kill switch
      const ks = await killSwitchService.getState();
      if (ks.global) {
        log.warn({ reason: ks.globalReason }, "Scheduled experiment skipped — kill switch engaged");
        return;
      }

      // Validate policy (conditions may have changed since schedule was created)
      const config = schedule.experiment_config as ExperimentConfig;
      const policyResult = await policyEngine.evaluate(config, {
        requestingUser: "chaos-scheduler",
        userRoles: ["chaos-operator"],
      });

      if (!policyResult.allowed) {
        log.warn(
          { violations: policyResult.violations.filter((v: any) => v.severity === "block") },
          "Scheduled experiment blocked by policy"
        );
        return;
      }

      // Create a new experiment instance for this run
      const experimentId = randomUUID();
      const runConfig: ExperimentConfig = {
        ...config,
        name: `${config.name}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}`,
        annotations: {
          ...config.annotations,
          "chaos.io/scheduled-by": schedule.id,
          "chaos.io/schedule": schedule.cron_expression,
        },
      };

      await db("experiments").insert({
        id: experimentId,
        config: JSON.stringify(runConfig),
        status: "pending",
        created_by: "chaos-scheduler",
        created_at: new Date(),
        selected_targets: JSON.stringify([]),
        events: JSON.stringify([]),
      });

      // Fire it
      await natsClient.publish("chaos.experiment.start", {
        experimentId,
        config: runConfig,
        requestedBy: "chaos-scheduler",
      });

      // Update last run time
      await db("scheduled_experiments")
        .where({ id: schedule.id })
        .update({ last_run_at: new Date() });

      log.info({ experimentId }, "Scheduled experiment fired");
    } finally {
      // Always release the advisory lock
      await db.raw(`SELECT pg_advisory_unlock(?)`, [lockId]);
    }
  }

  async disableSchedule(scheduleId: string): Promise<void> {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
    }

    await db("scheduled_experiments").where({ id: scheduleId }).update({ enabled: false });
    logger.info({ scheduleId }, "Schedule disabled");
  }

  async listSchedules(): Promise<ScheduledExperiment[]> {
    const rows = await db("scheduled_experiments").orderBy("created_at", "desc");
    return rows.map((r: any) => ({
      id: r.id,
      experimentConfig: r.experiment_config,
      cronExpression: r.cron_expression,
      enabled: r.enabled,
      lastRunAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      createdBy: r.created_by,
    }));
  }

  async shutdown(): Promise<void> {
    for (const [id, job] of this.jobs) {
      job.stop();
      logger.debug({ id }, "Scheduler job stopped");
    }
    this.jobs.clear();
  }
}

export const chaosScheduler = new ChaosScheduler();

// Hash a UUID string to a 32-bit integer for PostgreSQL advisory lock
function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}
