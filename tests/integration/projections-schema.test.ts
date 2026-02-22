import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { applyProjectionSchema } from '../../src/projections/schema.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  if (!store) store = new PostgresEventStore({ pool });
  await resetDatabase(pool);
  // Apply projection schema fresh for each test
  const client = await pool.connect();
  try {
    await applyProjectionSchema(client);
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool?.end();
});

describe('applyProjectionSchema()', () => {
  it('creates projection_checkpoints table', async () => {
    const result = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'projection_checkpoints'
      ) AS exists
    `);
    expect(result.rows[0]?.exists).toBe(true);
  });

  it('projection_checkpoints has nullable last_position', async () => {
    const result = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'projection_checkpoints'
        AND column_name = 'last_position'
    `);
    expect(result.rows[0]?.is_nullable).toBe('YES');
  });

  it('is idempotent — safe to call twice', async () => {
    // Call a second time — must not throw
    const client = await pool.connect();
    try {
      await expect(applyProjectionSchema(client)).resolves.toBeUndefined();
    } finally {
      client.release();
    }
  });

  it('creates the NOTIFY trigger on the events table', async () => {
    const result = await pool.query<{ trigger_name: string }>(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE event_object_table = 'events'
        AND trigger_name = 'trg_es_events_notify'
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('trigger fires once per store.append() call (FOR EACH STATEMENT)', async () => {
    // Listen for notifications on a dedicated client
    const listenClient = new pg.Client({ connectionString: process.env['TEST_DATABASE_URL'] });
    await listenClient.connect();

    let notificationCount = 0;
    try {
      await listenClient.query('LISTEN es_events');
      listenClient.on('notification', () => {
        notificationCount++;
      });

      // Append 3 events in one call (multi-event append)
      await store.append([
        { type: 'TestEvent', payload: { id: '1' } },
        { type: 'TestEvent', payload: { id: '2' } },
        { type: 'TestEvent', payload: { id: '3' } },
      ]);

      // Wait up to 500ms for notification
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    } finally {
      await listenClient.query('UNLISTEN es_events').catch(() => undefined);
      await listenClient.end();
    }

    // FOR EACH STATEMENT means exactly 1 notification for 3 rows
    expect(notificationCount).toBe(1);
  });

  it('NOTIFY is received within 500ms of store.append()', async () => {
    const listenClient = new pg.Client({ connectionString: process.env['TEST_DATABASE_URL'] });
    await listenClient.connect();

    let received = false;
    try {
      await listenClient.query('LISTEN es_events');
      listenClient.on('notification', () => { received = true; });

      const start = Date.now();
      await store.append({ type: 'PingEvent', payload: {} });

      // Poll until received or 500ms elapsed
      while (!received && Date.now() - start < 500) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await listenClient.query('UNLISTEN es_events').catch(() => undefined);
      await listenClient.end();
    }

    expect(received).toBe(true);
  });
});
