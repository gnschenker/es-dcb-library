/**
 * P0 #2 — empty batches, prevalidation, and atomic rollback.
 *
 * Local run (Docker required): npm run test:integration -- tests/integration/append-batch.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresEventStore,
  queryAll,
  queryItem,
  EmptyBatchError,
  MissingTagExtractorError,
} from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  await resetDatabase(pool);
  store = new PostgresEventStore({ pool });
});

afterAll(async () => {
  await pool?.end();
});

describe('P0 #2 — append batch validation', () => {
  it('rejects an empty batch and persists nothing', async () => {
    await expect(store.append([])).rejects.toBeInstanceOf(EmptyBatchError);

    const { events } = await store.load(queryAll());
    expect(events).toHaveLength(0);
  });

  it('rejects an empty batch with a condition and persists nothing', async () => {
    await expect(
      store.append([], { failIfEventsMatch: queryItem({ tags: ['order:o1'] }) }),
    ).rejects.toBeInstanceOf(EmptyBatchError);

    const { events } = await store.load(queryAll());
    expect(events).toHaveLength(0);
  });

  it('prevalidates the batch: a later invalid event rolls the batch back (nothing stored)', async () => {
    await expect(
      store.append([
        { type: 'OrderCreated', data: { orderId: 'o1' }, tags: ['order:o1'] },
        { type: 'OrderShipped', data: { orderId: 'o1' } },
      ]),
    ).rejects.toBeInstanceOf(MissingTagExtractorError);

    const { events } = await store.load(queryAll());
    expect(events).toHaveLength(0);
  });

  it('rolls back a mid-batch insert failure so earlier events in the batch are not visible', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    await expect(
      store.append([
        { type: 'Ok', data: { n: 1 }, tags: ['t'] },
        { type: 'Bad', data: circular, tags: ['t'] },
      ]),
    ).rejects.toThrow();

    const { events } = await store.load(queryAll());
    expect(events).toHaveLength(0);
  });

  it('allows a later successful append after a rejected batch (pool not left idle-in-transaction)', async () => {
    await expect(store.append([])).rejects.toBeInstanceOf(EmptyBatchError);
    await expect(
      store.append([{ type: 'OrderCreated', data: {}, tags: ['order:o1'] }]),
    ).resolves.toHaveLength(1);

    const { events } = await store.load(queryAll());
    expect(events).toHaveLength(1);
  });
});
