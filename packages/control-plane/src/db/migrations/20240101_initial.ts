// packages/control-plane/src/db/migrations/20240101_initial.ts
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

  await knex.raw(`
    CREATE TYPE experiment_status AS ENUM (
      'pending', 'dry-run', 'running', 'paused',
      'completed', 'failed', 'rolled-back', 'killed'
    )
  `);

  await knex.schema.createTable("experiments", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("uuid_generate_v4()"));
    t.jsonb("config").notNullable();
    t.specificType("status", "experiment_status").notNullable().defaultTo("pending");
    t.string("created_by").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("started_at", { useTz: true }).nullable();
    t.timestamp("completed_at", { useTz: true }).nullable();
    t.jsonb("selected_targets").notNullable().defaultTo("[]");
    t.jsonb("events").notNullable().defaultTo("[]");
    t.jsonb("metrics").nullable();
    t.text("rollback_reason").nullable();
  });

  await knex.raw(`
    ALTER TABLE experiments
    ADD COLUMN experiment_name TEXT GENERATED ALWAYS AS (config->>'name') STORED,
    ADD COLUMN experiment_type TEXT GENERATED ALWAYS AS (config->>'type') STORED,
    ADD COLUMN namespace TEXT GENERATED ALWAYS AS (config->'target'->>'namespace') STORED
  `);

  await knex.raw(`CREATE INDEX experiments_status_idx ON experiments(status)`);
  await knex.raw(`CREATE INDEX experiments_namespace_idx ON experiments(namespace)`);
  await knex.raw(`CREATE INDEX experiments_created_at_idx ON experiments(created_at DESC)`);
  await knex.raw(`CREATE INDEX experiments_name_search_idx ON experiments USING gin(experiment_name gin_trgm_ops)`);

  await knex.schema.createTable("kill_switch_audit", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("uuid_generate_v4()"));
    t.string("action").notNullable();
    t.string("scope").notNullable();
    t.string("namespace").nullable();
    t.uuid("experiment_id").nullable().references("id").inTable("experiments");
    t.text("reason").notNullable();
    t.string("requested_by").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("resilience_scores", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("uuid_generate_v4()"));
    t.string("namespace").notNullable();
    t.integer("score").notNullable().checkBetween([0, 100]);
    t.uuid("experiment_id").notNullable().references("id").inTable("experiments");
    t.timestamp("recorded_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("scheduled_experiments", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("uuid_generate_v4()"));
    t.jsonb("experiment_config").notNullable();
    t.string("cron_expression").notNullable();
    t.boolean("enabled").notNullable().defaultTo(true);
    t.timestamp("last_run_at", { useTz: true }).nullable();
    t.timestamp("next_run_at", { useTz: true }).nullable();
    t.string("created_by").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE OR REPLACE FUNCTION append_experiment_event(
      p_experiment_id UUID,
      p_event JSONB
    ) RETURNS VOID AS $$
    BEGIN
      UPDATE experiments
      SET events = events || p_event::jsonb
      WHERE id = p_experiment_id;
    END;
    $$ LANGUAGE plpgsql
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("scheduled_experiments");
  await knex.schema.dropTableIfExists("resilience_scores");
  await knex.schema.dropTableIfExists("kill_switch_audit");
  await knex.schema.dropTableIfExists("experiments");
  await knex.raw(`DROP TYPE IF EXISTS experiment_status`);
  await knex.raw(`DROP FUNCTION IF EXISTS append_experiment_event`);
}
