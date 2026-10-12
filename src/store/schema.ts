import type pg from 'pg';

export const DDL_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  data             JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  tags             TEXT[]       NOT NULL,
  tx_id            xid8         NOT NULL DEFAULT pg_current_xact_id()
)
`.trim();

export const DDL_CREATE_TX_ID_POSITION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_tx_id_position
  ON events (tx_id, global_position)
`.trim();

export const DDL_CREATE_TAGS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_tags_gin
  ON events USING GIN (tags array_ops)
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
  await client.query(DDL_CREATE_TAGS_INDEX);
  await client.query(DDL_CREATE_TYPE_POSITION_INDEX);
  await client.query(DDL_CREATE_TX_ID_POSITION_INDEX);
  await client.query(DDL_CREATE_BRIN_INDEX);
  await client.query(DDL_TUNE_AUTOVACUUM);
}
