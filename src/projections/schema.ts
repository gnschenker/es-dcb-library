import type pg from 'pg';

export const DDL_CREATE_CHECKPOINTS_TABLE = `
CREATE TABLE IF NOT EXISTS projection_checkpoints (
  name          TEXT        PRIMARY KEY,
  last_position BIGINT      NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`.trim();

export const DDL_CREATE_NOTIFY_FUNCTION = `
CREATE OR REPLACE FUNCTION es_notify_event_inserted()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('es_events', '');
  RETURN NULL;
END;
$$`.trim();

export const DDL_CREATE_NOTIFY_TRIGGER = `
CREATE OR REPLACE TRIGGER trg_es_events_notify
AFTER INSERT ON events
FOR EACH STATEMENT EXECUTE FUNCTION es_notify_event_inserted()`.trim();

export async function applyProjectionSchema(client: pg.ClientBase): Promise<void> {
  await client.query(DDL_CREATE_CHECKPOINTS_TABLE);
  await client.query(DDL_CREATE_NOTIFY_FUNCTION);
  await client.query(DDL_CREATE_NOTIFY_TRIGGER);
}
