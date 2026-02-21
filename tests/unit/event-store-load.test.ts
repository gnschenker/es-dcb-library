import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { EventStoreError } from '../../src/errors.js';
import { query } from '../../src/query/query-object.js';

// Helper to create a mock pool
function makeMockPool(rows: object[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    connect: vi.fn(),
    end: vi.fn(),
  };
}

// Helper to create a valid EventRow (as pg would return)
function makeRow(overrides: Partial<{
  global_position: string;
  event_id: string;
  type: string;
  payload: object;
  metadata: object | null;
  occurred_at: Date;
}> = {}) {
  return {
    global_position: '1',
    event_id: '00000000-0000-0000-0000-000000000001',
    type: 'TestEvent',
    payload: { x: 1 },
    metadata: null,
    occurred_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('PostgresEventStore.load()', () => {
  it('returns empty events and version 0n when no rows', async () => {
    const pool = makeMockPool([]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const result = await store.load(query.eventsOfType('X'));
    expect(result.events).toEqual([]);
    expect(result.version).toBe(0n);
  });

  it('returns one mapped event and correct version', async () => {
    const row = makeRow({ global_position: '42' });
    const pool = makeMockPool([row]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const result = await store.load(query.eventsOfType('TestEvent'));
    expect(result.events).toHaveLength(1);
    expect(result.version).toBe(42n);
    expect(result.events[0]!.globalPosition).toBe(42n);
  });

  it('returns all events and version = last globalPosition', async () => {
    const rows = [
      makeRow({ global_position: '10' }),
      makeRow({ global_position: '20' }),
      makeRow({ global_position: '30' }),
    ];
    const pool = makeMockPool(rows);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const result = await store.load(query.eventsOfType('TestEvent'));
    expect(result.events).toHaveLength(3);
    expect(result.version).toBe(30n);
  });

  it('calls pool.query with compiled SQL and params', async () => {
    const pool = makeMockPool([]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const q = query.eventsOfType('OrderCreated');
    await store.load(q);
    expect(pool.query).toHaveBeenCalledOnce();
    const [calledSql, calledParams] = pool.query.mock.calls[0]!;
    expect(calledSql).toContain('SELECT global_position');
    expect(calledSql).toContain('ORDER BY global_position ASC');
    expect(calledParams).toContain('OrderCreated');
  });

  it('wraps pool.query errors in EventStoreError', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    await expect(store.load(query.eventsOfType('X'))).rejects.toBeInstanceOf(EventStoreError);
  });

  it('returns events in the order returned by the DB', async () => {
    const rows = [
      makeRow({ global_position: '5' }),
      makeRow({ global_position: '10' }),
      makeRow({ global_position: '15' }),
    ];
    const pool = makeMockPool(rows);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const result = await store.load(query.eventsOfType('TestEvent'));
    expect(result.events.map(e => e.globalPosition)).toEqual([5n, 10n, 15n]);
  });
});
