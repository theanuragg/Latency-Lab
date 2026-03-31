-- docker/init.sql
-- Database schema for the chaos platform.
--
-- Design decisions:
-- 1. Experiments are immutable once created (config column never changes).
--    Status updates go in the status column + events JSONB array.
--    This gives us a full audit trail without a separate audit table.
--
-- 2. events and selected_targets are JSONB arrays, not separate tables.
--    Experiments have O(tens) of events, never O(millions).
--    JSONB is simpler and queryable without joins.
--
-- 3. metrics is JSONB — the schema is versioned by the app, not the DB.
--    This avoids migrations every time we add a new metric.
--
-- 4. Full-text search on experiment names via GIN index.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for trigram search

CREATE TYPE experiment_status AS ENUM (
  'pending',
  'dry-run',
  'running',
  'paused',
  'completed',
  'failed',
  'rolled-back',
  'killed'
);

CREATE TABLE experiments (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config            JSONB NOT NULL,
  status            experiment_status NOT NULL DEFAULT 'pending',
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  selected_targets  JSONB NOT NULL DEFAULT '[]',
  events            JSONB NOT NULL DEFAULT '[]',
  metrics           JSONB,
  rollback_reason   TEXT,

  -- Denormalized for fast queries (avoid digging into config JSONB)
  experiment_name   TEXT GENERATED ALWAYS AS (config->>'name') STORED,
  experiment_type   TEXT GENERATED ALWAYS AS (config->>'type') STORED,
  namespace         TEXT GENERATED ALWAYS AS (config->'target'->>'namespace') STORED
);

-- Indexes for common query patterns
CREATE INDEX experiments_status_idx ON experiments(status);
CREATE INDEX experiments_namespace_idx ON experiments(namespace);
CREATE INDEX experiments_type_idx ON experiments(experiment_type);
CREATE INDEX experiments_created_at_idx ON experiments(created_at DESC);
CREATE INDEX experiments_name_search_idx ON experiments USING gin(experiment_name gin_trgm_ops);

-- For the metrics API: find high-scoring experiments
CREATE INDEX experiments_chaos_score_idx ON experiments USING btree((metrics->>'chaosScore'));

-- Audit log — immutable record of all kill switch operations
-- Separate from experiments because kill switch events don't belong to an experiment
CREATE TABLE kill_switch_audit (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action          TEXT NOT NULL,  -- 'engage' | 'disengage'
  scope           TEXT NOT NULL,  -- 'global' | 'namespace' | 'experiment'
  namespace       TEXT,
  experiment_id   UUID REFERENCES experiments(id),
  reason          TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX kill_switch_audit_created_at_idx ON kill_switch_audit(created_at DESC);

-- Resilience scores over time (materialized for dashboard queries)
CREATE TABLE resilience_scores (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  namespace       TEXT NOT NULL,
  score           INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  experiment_id   UUID NOT NULL REFERENCES experiments(id),
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX resilience_scores_namespace_time_idx ON resilience_scores(namespace, recorded_at DESC);

-- Scheduled experiments (separate from cron implementation)
CREATE TABLE scheduled_experiments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  experiment_config JSONB NOT NULL,
  cron_expression TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Function to append an event to an experiment (avoids read-modify-write race)
CREATE OR REPLACE FUNCTION append_experiment_event(
  p_experiment_id UUID,
  p_event JSONB
) RETURNS VOID AS $$
BEGIN
  UPDATE experiments
  SET events = events || p_event::jsonb
  WHERE id = p_experiment_id;
END;
$$ LANGUAGE plpgsql;

-- Convenience view for the dashboard
CREATE VIEW experiment_summary AS
SELECT
  id,
  experiment_name AS name,
  experiment_type AS type,
  status,
  namespace,
  created_by,
  created_at,
  started_at,
  completed_at,
  EXTRACT(EPOCH FROM (completed_at - started_at))::INTEGER AS duration_seconds,
  (metrics->>'chaosScore')::INTEGER AS chaos_score,
  (metrics->>'mttrSeconds')::FLOAT AS mttr_seconds,
  (metrics->>'errorRatePeak')::FLOAT AS error_rate_peak,
  jsonb_array_length(selected_targets) AS target_count
FROM experiments;
