/**
 * P2 #8 — projection restart and checkpoint recovery.
 *
 * Local run (Docker required):
 *   npm run test:integration -- tests/integration/p2-projection-recovery.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresEventStore,
  queryAll,
  queryItem,
  ProjectionNotReadyError,
  eventStreamCursor,
} from '../../src/index.js';
import { ProjectionManager, defineProjection } from '../../src/projections/index.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { resetProjectionSchema } from './projections-helpers.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) {
    pool = createTestPool();
    store = new PostgresEventStore({ pool });
  }
  await resetDatabase(pool);
  await resetProjectionSchema(pool);
  await pool.query('DROP TABLE IF EXISTS p2_read_model');
});

afterAll(async () => {
  await pool?.end();
});

function countingProjection(name: string, handler: (eventType: string, client: pg.PoolClient) => Promise<void>) {
  return defineProjection({
    name,
    query: queryAll(),
    setup: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS p2_read_model (
          event_id TEXT PRIMARY KEY,
          type TEXT NOT NULL
        )
      `);
    },
    handler: async (event, client) => {
      await handler(event.type, client);
      await client.query(
        `INSERT INTO p2_read_model (event_id, type) VALUES ($1, $2)
         ON CONFLICT (event_id) DO UPDATE SET type = EXCLUDED.type`,
        [event.eventId, event.type],
      );
    },
  });
}

describe('P2 #8 — projection restart / recovery', () => {
  it('waitUntilLive fails while a projection is in error, then restart recovers', async () => {
    let failNext = true;
    const projection = countingProjection('p2-restart', async () => {
      if (failNext) {
        failNext = false;
        throw new Error('transient handler failure');
      }
    });

    await store.append({ type: 'Seed', data: {}, tags: ['p2'] });

    const manager = new ProjectionManager({
      pool,
      store,
      projections: [projection],
      maxRetries: 0,
      onError: () => undefined,
    });
    await manager.initialize();
    manager.start();

    await expect(manager.waitUntilLive(15_000)).rejects.toBeInstanceOf(ProjectionNotReadyError);
    expect(manager.getStatus().find((s) => s.name === 'p2-restart')?.status).toBe('error');

    await manager.restart('p2-restart');
    await manager.waitUntilLive(15_000);

    const rows = await pool.query<{ type: string }>('SELECT type FROM p2_read_model');
    expect(rows.rows.map((r) => r.type)).toEqual(['Seed']);

    await manager.stop();
  }, 40_000);

  it('a new manager resumes from the checkpoint after stop', async () => {
    const projection = countingProjection('p2-resume', async () => undefined);

    const first = new ProjectionManager({
      pool,
      store,
      projections: [projection],
      onError: () => undefined,
    });
    await first.initialize();
    first.start();
    await first.waitUntilLive(15_000);

    const [a] = await store.append({ type: 'A', data: {}, tags: ['p2'] });
    await first.waitForCursor('p2-resume', eventStreamCursor(a!), 15_000);
    await first.stop();

    const [b] = await store.append({ type: 'B', data: {}, tags: ['p2'] });

    const second = new ProjectionManager({
      pool,
      store,
      projections: [projection],
      onError: () => undefined,
    });
    await second.initialize();
    second.start();
    await second.waitUntilLive(15_000);
    await second.waitForCursor('p2-resume', eventStreamCursor(b!), 15_000);

    const rows = await pool.query<{ type: string }>(
      'SELECT type FROM p2_read_model ORDER BY type',
    );
    expect(rows.rows.map((r) => r.type)).toEqual(['A', 'B']);

    await second.stop();
  }, 40_000);

  it('waitForCursor uses (tx_id, global_position) after a committed append', async () => {
    const projection = countingProjection('p2-cursor', async () => undefined);
    const manager = new ProjectionManager({
      pool,
      store,
      projections: [projection],
      onError: () => undefined,
    });
    await manager.initialize();
    manager.start();
    await manager.waitUntilLive(15_000);

    const q = queryItem({ tags: ['p2'] });
    const stored = await store.append({ type: 'CursorEvt', data: {}, tags: ['p2'] });
    const { position } = await store.load(q);

    await manager.waitForCursor('p2-cursor', position, 15_000);
    expect(stored[0]!.txId).toBe(position.txId);
    expect(stored[0]!.globalPosition).toBe(position.globalPosition);

    await manager.stop();
  }, 40_000);
});
