// packages/chaos-engine/src/db/index.ts
// The chaos engine needs direct DB access to update experiment status and events.
// It uses the same schema as the control plane.

import Knex from "knex";
import { logger } from "../logger";

export const db = Knex({
  client: "pg",
  connection: process.env.DATABASE_URL,
  pool: { min: 1, max: 5 },
});

// Re-export the same repository shape the control plane uses
import type {
  ExperimentStatus,
  ExperimentEvent,
  ExperimentMetrics,
  SelectedTarget,
} from "@chaos/shared-types";

export const experimentRepository = {
  async updateStatus(
    id: string,
    status: ExperimentStatus,
    extra?: { rollbackReason?: string }
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (status === "running") update.started_at = new Date();
    if (["completed", "failed", "rolled-back", "killed"].includes(status)) {
      update.completed_at = new Date();
    }
    if (extra?.rollbackReason) update.rollback_reason = extra.rollbackReason;
    await db("experiments").where({ id }).update(update);
  },

  async setTargets(id: string, targets: SelectedTarget[]): Promise<void> {
    await db("experiments")
      .where({ id })
      .update({ selected_targets: JSON.stringify(targets) });
  },

  async addEvent(id: string, event: ExperimentEvent): Promise<void> {
    await db.raw("SELECT append_experiment_event(?, ?::jsonb)", [
      id,
      JSON.stringify(event),
    ]);
  },

  async setMetrics(id: string, metrics: ExperimentMetrics): Promise<void> {
    await db("experiments")
      .where({ id })
      .update({ metrics: JSON.stringify(metrics) });

    const experiment = await db("experiments").where({ id }).first();
    if (experiment && metrics.chaosScore !== undefined) {
      const ns =
        (typeof experiment.config === "string"
          ? JSON.parse(experiment.config)
          : experiment.config)?.target?.namespace ?? "default";
      await db("resilience_scores").insert({
        namespace: ns,
        score: metrics.chaosScore,
        experiment_id: id,
      });
    }
  },

  async setRollbackReason(id: string, reason: string): Promise<void> {
    await db("experiments").where({ id }).update({ rollback_reason: reason });
  },
};
