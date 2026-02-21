import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { query } from '../../src/query/query-object.js';
import { EventStoreError } from '../../src/errors.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  if (!store) store = new PostgresEventStore({ pool });
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('PostgresEventStore.append() (integration)', () => {
  it('appends a single event and returns StoredEvent with correct fields', async () => {
    const [stored] = await store.append({ type: 'OrderCreated', payload: { orderId: 'o1' } });
    expect(stored!.globalPosition).toBeGreaterThanOrEqual(1n);
    expect(stored!.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored!.type).toBe('OrderCreated');
    expect(stored!.payload).toEqual({ orderId: 'o1' });
    expect(stored!.metadata).toBeNull();
    expect(stored!.occurredAt).toBeInstanceOf(Date);
  });

  it('appends multiple events with sequential globalPositions', async () => {
    const result = await store.append([
      { type: 'A', payload: { n: 1 } },
      { type: 'A', payload: { n: 2 } },
      { type: 'A', payload: { n: 3 } },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]!.globalPosition).toBeLessThan(result[1]!.globalPosition);
    expect(result[1]!.globalPosition).toBeLessThan(result[2]!.globalPosition);
  });

  it('stores and returns metadata when provided', async () => {
    const [stored] = await store.append({
      type: 'X', payload: {}, metadata: { correlationId: 'corr-123' }
    });
    expect((stored!.metadata as Record<string, unknown>)['correlationId']).toBe('corr-123');
  });

  it('succeeds without AppendOptions (no concurrency check)', async () => {
    await expect(store.append({ type: 'X', payload: {} })).resolves.toHaveLength(1);
    await expect(store.append({ type: 'X', payload: {} })).resolves.toHaveLength(1);
  });

  it('globalPositions are strictly increasing across multiple append calls', async () => {
    const [a] = await store.append({ type: 'X', payload: {} });
    const [b] = await store.append({ type: 'X', payload: {} });
    expect(a!.globalPosition).toBeLessThan(b!.globalPosition);
  });

  it('appended events are visible to subsequent load()', async () => {
    await store.append({ type: 'Visible', payload: { v: 1 } });
    const result = await store.load(query.eventsOfType('Visible'));
    expect(result.events).toHaveLength(1);
    expect((result.events[0]!.payload as Record<string, unknown>)['v']).toBe(1);
  });

  it('rolls back all inserts when one fails mid-batch', async () => {
    // Count events before the test
    const countBefore = parseInt(
      String((await pool.query('SELECT COUNT(*) AS cnt FROM events')).rows[0]!['cnt']),
      10,
    );

    // Build a fake pool whose client fails on the second INSERT, simulating a mid-batch failure.
    // This verifies that append() issues ROLLBACK and wraps the error in EventStoreError,
    // leaving no events committed.
    let insertCallCount = 0;
    const realClient = await pool.connect();

    const fakeClient = {
      query: async (sql: string, params?: unknown[]) => {
        const sqlStr = String(sql);
        if (/INSERT/i.test(sqlStr)) {
          insertCallCount++;
          if (insertCallCount === 2) {
            throw new Error('simulated constraint violation on second insert');
          }
          // First INSERT goes through real client
          return realClient.query(sql, params as unknown[]);
        }
        // BEGIN / ROLLBACK go through real client
        return realClient.query(sql);
      },
      release: () => {
        realClient.release();
      },
    };

    const fakePool = {
      connect: async () => fakeClient,
    } as unknown as pg.Pool;

    const storeWithFakePool = new PostgresEventStore({ pool: fakePool });

    // The append should throw EventStoreError because the second insert fails
    await expect(
      storeWithFakePool.append([
        { type: 'RollbackTest', payload: { n: 1 } },
        { type: 'RollbackTest', payload: { n: 2 } },
        { type: 'RollbackTest', payload: { n: 3 } },
      ])
    ).rejects.toBeInstanceOf(EventStoreError);

    // Verify the event count is unchanged — the first insert was rolled back
    const countAfter = parseInt(
      String((await pool.query('SELECT COUNT(*) AS cnt FROM events')).rows[0]!['cnt']),
      10,
    );
    expect(countAfter).toBe(countBefore);
  });
});
