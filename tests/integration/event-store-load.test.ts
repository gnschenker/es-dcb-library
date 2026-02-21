import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { query } from '../../src/query/query-object.js';
import { createTestPool, resetDatabase, seedEvents } from './helpers.js';

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

describe('PostgresEventStore.load() — integration', () => {
  it('returns empty result when no events exist', async () => {
    const result = await store.load(query.eventsOfType('OrderCreated'));
    expect(result.events).toEqual([]);
    expect(result.version).toBe(0n);
  });

  it('filters by event type', async () => {
    await seedEvents(pool, [
      { type: 'OrderCreated', payload: { id: 1 } },
      { type: 'OrderCreated', payload: { id: 2 } },
      { type: 'OrderCreated', payload: { id: 3 } },
      { type: 'OrderShipped', payload: { id: 1 } },
      { type: 'OrderShipped', payload: { id: 2 } },
    ]);
    const result = await store.load(query.eventsOfType('OrderCreated'));
    expect(result.events).toHaveLength(3);
    expect(result.events.every(e => e.type === 'OrderCreated')).toBe(true);
  });

  it('filters by payload attribute', async () => {
    await seedEvents(pool, [
      { type: 'OrderCreated', payload: { customerId: 'c1' } },
      { type: 'OrderCreated', payload: { customerId: 'c2' } },
      { type: 'OrderCreated', payload: { customerId: 'c1' } },
    ]);
    const result = await store.load(
      query.eventsOfType('OrderCreated').where.key('customerId').equals('c1')
    );
    expect(result.events).toHaveLength(2);
    expect(result.events.every(e => (e.payload as any).customerId === 'c1')).toBe(true);
  });

  it('applies AND filter correctly', async () => {
    await seedEvents(pool, [
      { type: 'Order', payload: { a: 1, b: 2 } },
      { type: 'Order', payload: { a: 1, b: 3 } },
      { type: 'Order', payload: { a: 2, b: 2 } },
    ]);
    const result = await store.load(
      query.eventsOfType('Order').where.key('a').equals(1).and.key('b').equals(2)
    );
    expect(result.events).toHaveLength(1);
    expect((result.events[0]!.payload as any)).toMatchObject({ a: 1, b: 2 });
  });

  it('applies OR filter correctly', async () => {
    await seedEvents(pool, [
      { type: 'Order', payload: { status: 'pending' } },
      { type: 'Order', payload: { status: 'active' } },
      { type: 'Order', payload: { status: 'completed' } },
    ]);
    const result = await store.load(
      query.eventsOfType('Order').where.key('status').equals('pending').or.key('status').equals('active')
    );
    expect(result.events).toHaveLength(2);
  });

  it('returns events of multiple types in global_position order', async () => {
    await seedEvents(pool, [
      { type: 'TypeA', payload: {} },
      { type: 'TypeB', payload: {} },
      { type: 'TypeA', payload: {} },
    ]);
    const result = await store.load(
      query.eventsOfType('TypeA').eventsOfType('TypeB')
    );
    expect(result.events).toHaveLength(3);
    // should be in global_position order
    const positions = result.events.map(e => e.globalPosition);
    expect(positions).toEqual([...positions].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('version equals globalPosition of last returned event', async () => {
    await seedEvents(pool, [
      { type: 'X', payload: {} },
      { type: 'X', payload: {} },
    ]);
    const result = await store.load(query.eventsOfType('X'));
    expect(result.version).toBe(result.events[result.events.length - 1]!.globalPosition);
    expect(typeof result.version).toBe('bigint');
  });

  it('version reflects only matched events when multiple types exist', async () => {
    // Seed A, A, B so that A's last position (2) is less than B's position (3)
    // This ensures resultA.version < resultAll.version
    await seedEvents(pool, [
      { type: 'A', payload: {} },
      { type: 'A', payload: {} },
      { type: 'B', payload: {} },
    ]);
    const resultA = await store.load(query.eventsOfType('A'));
    const resultAll = await store.load(query.eventsOfType('A').eventsOfType('B'));
    // version for A only should be less than version for all (B is last at position 3)
    expect(resultA.version).toBeLessThan(resultAll.version);
  });

  it('returns version 0n when no events match even if other types exist', async () => {
    await seedEvents(pool, [{ type: 'Other', payload: {} }]);
    const result = await store.load(query.eventsOfType('NotExist'));
    expect(result.events).toHaveLength(0);
    expect(result.version).toBe(0n);
  });
});
