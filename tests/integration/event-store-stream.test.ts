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

async function collectStream(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const item of gen) results.push(item);
  return results;
}

describe('PostgresEventStore.stream() integration', () => {
  it('yields nothing for a type with no events', async () => {
    const events = await collectStream(store.stream(query.eventsOfType('Nonexistent')));
    expect(events).toHaveLength(0);
  });

  it('yields all events when they fit in one page', async () => {
    await seedEvents(pool, Array.from({ length: 5 }, (_, i) => ({ type: 'X', payload: { n: i } })));
    const events = await collectStream(store.stream(query.eventsOfType('X'), { batchSize: 100 }));
    expect(events).toHaveLength(5);
  });

  it('yields all events across multiple pages', async () => {
    await seedEvents(pool, Array.from({ length: 25 }, (_, i) => ({ type: 'Page', payload: { n: i } })));
    const events = await collectStream(store.stream(query.eventsOfType('Page'), { batchSize: 10 }));
    expect(events).toHaveLength(25);
  });

  it('only yields events after the given position', async () => {
    await seedEvents(pool, Array.from({ length: 10 }, (_, i) => ({ type: 'Pos', payload: { n: i } })));
    const all = await collectStream(store.stream(query.eventsOfType('Pos')));
    const cutoff = (all[4] as any).globalPosition as bigint;
    const after = await collectStream(store.stream(query.eventsOfType('Pos'), { afterPosition: cutoff }));
    expect(after).toHaveLength(5);
  });

  it('yields events in strict ascending globalPosition order', async () => {
    await seedEvents(pool, Array.from({ length: 10 }, (_, i) => ({ type: 'Ord', payload: { n: i } })));
    const events = await collectStream(store.stream(query.eventsOfType('Ord'))) as any[];
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.globalPosition).toBeGreaterThan(events[i - 1]!.globalPosition);
    }
  });

  it('allows early break without error', async () => {
    await seedEvents(pool, Array.from({ length: 20 }, (_, i) => ({ type: 'Break', payload: { n: i } })));
    const collected: unknown[] = [];
    for await (const event of store.stream(query.eventsOfType('Break'), { batchSize: 100 })) {
      collected.push(event);
      if (collected.length === 5) break;
    }
    expect(collected).toHaveLength(5);
  });

  it('streams events matching multiple types in position order', async () => {
    await seedEvents(pool, [
      { type: 'Multi1', payload: {} },
      { type: 'Multi2', payload: {} },
      { type: 'Multi1', payload: {} },
    ]);
    const events = await collectStream(
      store.stream(query.eventsOfType('Multi1').eventsOfType('Multi2'))
    ) as any[];
    expect(events).toHaveLength(3);
    const types = events.map((e: any) => e.type);
    expect(types).toContain('Multi1');
    expect(types).toContain('Multi2');
  });

  it('applies payload filter during streaming', async () => {
    await seedEvents(pool, [
      { type: 'Filtered', payload: { match: true } },
      { type: 'Filtered', payload: { match: false } },
      { type: 'Filtered', payload: { match: true } },
    ]);
    const events = await collectStream(
      store.stream(query.eventsOfType('Filtered').where.key('match').equals(true))
    ) as any[];
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.payload.match === true)).toBe(true);
  });

  it('uses default batchSize of 100', async () => {
    await seedEvents(pool, Array.from({ length: 100 }, (_, i) => ({ type: 'Default', payload: { n: i } })));
    const events = await collectStream(store.stream(query.eventsOfType('Default')));
    expect(events).toHaveLength(100);
  });
});
