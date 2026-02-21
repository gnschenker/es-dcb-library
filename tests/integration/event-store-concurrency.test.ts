import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { ConcurrencyError } from '../../src/errors.js';
import { query } from '../../src/query/query-object.js';
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

describe('PostgresEventStore append() with advisory locks — integration', () => {
  it('succeeds on first write with expectedVersion 0n', async () => {
    const q = query.eventsOfType('OrderCreated');
    const result = await store.append(
      { type: 'OrderCreated', payload: {} },
      { query: q, expectedVersion: 0n }
    );
    expect(result).toHaveLength(1);
  });

  it('succeeds when expectedVersion matches actual version', async () => {
    const q = query.eventsOfType('OrderCreated');
    await store.append({ type: 'OrderCreated', payload: {} }, { query: q, expectedVersion: 0n });
    const { version } = await store.load(q);
    const result = await store.append(
      { type: 'OrderCreated', payload: {} },
      { query: q, expectedVersion: version }
    );
    expect(result).toHaveLength(1);
  });

  it('throws ConcurrencyError when expectedVersion is stale', async () => {
    const q = query.eventsOfType('OrderCreated');
    await store.append({ type: 'OrderCreated', payload: {} }, { query: q, expectedVersion: 0n });
    await expect(
      store.append({ type: 'OrderCreated', payload: {} }, { query: q, expectedVersion: 0n })
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it('ConcurrencyError has correct expectedVersion and actualVersion', async () => {
    const q = query.eventsOfType('X');
    await store.append({ type: 'X', payload: {} }, { query: q, expectedVersion: 0n });
    const { version: actual } = await store.load(q);
    const err = await store.append(
      { type: 'X', payload: {} },
      { query: q, expectedVersion: 0n }
    ).catch(e => e) as ConcurrencyError;
    expect(err.expectedVersion).toBe(0n);
    expect(err.actualVersion).toBe(actual);
  });

  it('no new events persisted after ConcurrencyError', async () => {
    const q = query.eventsOfType('X');
    await store.append({ type: 'X', payload: {} }, { query: q, expectedVersion: 0n });
    const { events: before } = await store.load(q);
    await store.append({ type: 'X', payload: {} }, { query: q, expectedVersion: 0n }).catch(() => undefined);
    const { events: after } = await store.load(q);
    expect(after).toHaveLength(before.length);
  });

  it('only one of two concurrent appends with same expectedVersion succeeds', async () => {
    const q = query.eventsOfType('ConcurrentOrder');
    // Two separate store instances (simulating two processes)
    const store2 = new PostgresEventStore({ pool });

    // Both try to append with expectedVersion: 0n simultaneously
    const results = await Promise.allSettled([
      store.append({ type: 'ConcurrentOrder', payload: { writer: 1 } }, { query: q, expectedVersion: 0n }),
      store2.append({ type: 'ConcurrentOrder', payload: { writer: 2 } }, { query: q, expectedVersion: 0n }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrencyError);
  });

  it('concurrencyQuery allows narrow conflict scope — write to different type does not conflict', async () => {
    const narrowQ = query.eventsOfType('TypeA');
    // Append a TypeB event — should NOT conflict with a TypeA concurrencyQuery
    await store.append({ type: 'TypeB', payload: {} });
    const { version: versionA } = await store.load(narrowQ); // 0n — no TypeA events
    // This should succeed because concurrencyQuery only checks TypeA
    const result = await store.append(
      { type: 'TypeA', payload: {} },
      { query: query.eventsOfType('TypeA').eventsOfType('TypeB'), expectedVersion: versionA, concurrencyQuery: narrowQ }
    );
    expect(result).toHaveLength(1);
  });

  it('version advances after successful append and new write with updated version succeeds', async () => {
    const q = query.eventsOfType('Seq');
    await store.append({ type: 'Seq', payload: {} }, { query: q, expectedVersion: 0n });
    const { version: v1 } = await store.load(q);
    await store.append({ type: 'Seq', payload: {} }, { query: q, expectedVersion: v1 });
    const { version: v2 } = await store.load(q);
    expect(v2).toBeGreaterThan(v1);
  });
});
