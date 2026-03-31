// packages/control-plane/src/db/repositories/experiments.ts
// Repository pattern — all database access for experiments goes here.
// No SQL scattered across the codebase.

import { db } from "../index";
import type {
  Experiment,
  ExperimentConfig,
  ExperimentStatus,
  ExperimentEvent,
  ExperimentMetrics,
  SelectedTarget,
} from "@chaos/shared-types";

interface CreateExperimentInput {
  id: string;
  config: ExperimentConfig;
  status: ExperimentStatus;
  createdBy: string;
  createdAt: Date;
  selectedTargets: SelectedTarget[];
  events: ExperimentEvent[];
}

interface ListOptions {
  status?: ExperimentStatus;
  namespace?: string;
  limit: number;
  offset: number;
}

export const experimentRepository = {
  async create(input: CreateExperimentInput): Promise<void> {
    await db("experiments").insert({
      id: input.id,
      config: JSON.stringify(input.config),
      status: input.status,
      created_by: input.createdBy,
      created_at: input.createdAt,
      selected_targets: JSON.stringify(input.selectedTargets),
      events: JSON.stringify(input.events),
    });
  },

  async findById(id: string): Promise<Experiment | null> {
    const row = await db("experiments").where({ id }).first();
    if (!row) return null;
    return rowToExperiment(row);
  },

  async list(options: ListOptions): Promise<Experiment[]> {
    let query = db("experiments").orderBy("created_at", "desc");

    if (options.status) query = query.where({ status: options.status });
    if (options.namespace) {
      query = query.whereRaw("config->'target'->>'namespace' = ?", [options.namespace]);
    }

    const rows = await query.limit(options.limit).offset(options.offset);
    return rows.map(rowToExperiment);
  },

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
    // Use the PostgreSQL function to atomically append — avoids read-modify-write race
    await db.raw("SELECT append_experiment_event(?, ?::jsonb)", [
      id,
      JSON.stringify(event),
    ]);
  },

  async setMetrics(id: string, metrics: ExperimentMetrics): Promise<void> {
    await db("experiments")
      .where({ id })
      .update({ metrics: JSON.stringify(metrics) });

    // Also write to resilience_scores for trend tracking
    const experiment = await db("experiments").where({ id }).first();
    if (experiment && metrics.chaosScore !== undefined) {
      const ns = experiment.config?.target?.namespace ?? "default";
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

  async getResilienceScores(
    namespace: string,
    limit = 30
  ): Promise<Array<{ score: number; recordedAt: Date; experimentId: string }>> {
    const rows = await db("resilience_scores")
      .where({ namespace })
      .orderBy("recorded_at", "desc")
      .limit(limit);

    return rows.map((r: any) => ({
      score: r.score,
      recordedAt: r.recorded_at,
      experimentId: r.experiment_id,
    }));
  },
};

function rowToExperiment(row: any): Experiment {
  return {
    id: row.id,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    selectedTargets:
      typeof row.selected_targets === "string"
        ? JSON.parse(row.selected_targets)
        : row.selected_targets ?? [],
    events:
      typeof row.events === "string"
        ? JSON.parse(row.events)
        : row.events ?? [],
    metrics: row.metrics
      ? typeof row.metrics === "string"
        ? JSON.parse(row.metrics)
        : row.metrics
      : undefined,
    rollbackReason: row.rollback_reason ?? undefined,
  };
}
