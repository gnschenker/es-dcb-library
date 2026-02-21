import type pg from 'pg';

export const DDL_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  payload          JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
)
`.trim();

export const DDL_CREATE_GIN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_payload_gin
  ON events USING GIN (payload jsonb_path_ops)
`.trim();

export const DDL_TUNE_GIN_INDEX = `
ALTER INDEX IF EXISTS idx_events_payload_gin
  SET (fastupdate = on, gin_pending_list_limit = 65536)
`.trim();

export const DDL_CREATE_TYPE_POSITION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_type_position
  ON events (type, global_position)
`.trim();

export const DDL_CREATE_BRIN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_occurred_at_brin
  ON events USING BRIN (occurred_at)
  WITH (pages_per_range = 128)
`.trim();

export const DDL_TUNE_AUTOVACUUM = `
ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor  = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay    = 2
)
`.trim();

export async function applySchema(client: pg.ClientBase): Promise<void> {
  await client.query(DDL_CREATE_TABLE);
  await client.query(DDL_CREATE_GIN_INDEX);
  await client.query(DDL_TUNE_GIN_INDEX);
  await client.query(DDL_CREATE_TYPE_POSITION_INDEX);
  await client.query(DDL_CREATE_BRIN_INDEX);
  await client.query(DDL_TUNE_AUTOVACUUM);
}
