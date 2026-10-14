/**
 * P1 #4 — waitUntilLive fails when a projection errors.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryItem, ProjectionNotReadyError } from '../../src/index.js';
import { ProjectionManager, defineProjection } from '../../src/projections/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('P1 #4 waitUntilLive', () => {
  it('throws ProjectionNotReadyError when a projection handler stays in error', async () => {
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'Boom', data: {}, tags: ['p1'] });

    const projection = defineProjection({
      name: 'always-fails',
      query: queryItem({ types: ['Boom'] }),
      handler: async () => {
        throw new Error('handler boom');
      },
    });

    const manager = new ProjectionManager({
      pool,
      store,
      projections: [projection],
      maxRetries: 0,
      onError: () => undefined,
    });
    await manager.initialize();
    manager.start();

    await expect(manager.waitUntilLive(10_000)).rejects.toBeInstanceOf(ProjectionNotReadyError);
    await manager.stop();
  }, 30_000);
});
