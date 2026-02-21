import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { EventStoreError } from '../../src/errors.js';
import { query } from '../../src/query/query-object.js';

function makeRow(globalPosition: string, type = 'TestEvent') {
  return {
    global_position: globalPosition,
    event_id: `00000000-0000-0000-0000-${globalPosition.padStart(12, '0')}`,
    type,
    payload: {},
    metadata: null,
    occurred_at: new Date(),
  };
}

function makeMockPool(...pageRows: object[][]) {
  const pool = {
    query: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
  };
  for (const rows of pageRows) {
    pool.query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  }
  return pool;
}

describe('PostgresEventStore.stream()', () => {
  it('yields nothing when first page is empty', async () => {
    const pool = makeMockPool([]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const events: unknown[] = [];
    for await (const event of store.stream(query.eventsOfType('X'))) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('yields all rows and stops when rowCount < batchSize', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => makeRow(String(i + 1)));
    const pool = makeMockPool(rows);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const events: unknown[] = [];
    for await (const event of store.stream(query.eventsOfType('X'), { batchSize: 100 })) {
      events.push(event);
    }
    expect(events).toHaveLength(50);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  it('makes second query when first page is full, stops on empty second page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(String(i + 1)));
    const pool = makeMockPool(page1, []);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const events: unknown[] = [];
    for await (const event of store.stream(query.eventsOfType('X'), { batchSize: 100 })) {
      events.push(event);
    }
    expect(events).toHaveLength(100);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('yields events across two pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(String(i + 1)));
    const page2 = Array.from({ length: 50 }, (_, i) => makeRow(String(i + 101)));
    const pool = makeMockPool(page1, page2);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    const events: unknown[] = [];
    for await (const event of store.stream(query.eventsOfType('X'), { batchSize: 100 })) {
      events.push(event);
    }
    expect(events).toHaveLength(150);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('starts after the given afterPosition', async () => {
    const pool = makeMockPool([]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    for await (const _ of store.stream(query.eventsOfType('X'), { afterPosition: 5n })) {
      // nothing
    }
    const [, params] = pool.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toContain(5n);
  });

  it('uses the specified batchSize as LIMIT', async () => {
    const pool = makeMockPool([]);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    for await (const _ of store.stream(query.eventsOfType('X'), { batchSize: 10 })) {
      // nothing
    }
    const [, params] = pool.query.mock.calls[0]! as [string, unknown[]];
    expect(params).toContain(10);
  });

  it('uses last row globalPosition as afterPosition for the next page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeRow(String(i + 1)));
    const pool = makeMockPool(page1, []);
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    for await (const _ of store.stream(query.eventsOfType('X'), { batchSize: 100 })) {
      // consume all
    }
    const [, params2] = pool.query.mock.calls[1]! as [string, unknown[]];
    expect(params2).toContain(100n);
  });

  it('wraps pool.query errors in EventStoreError', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
      connect: vi.fn(),
      end: vi.fn(),
    };
    const store = new PostgresEventStore({ pool: pool as unknown as pg.Pool });
    await expect(async () => {
      for await (const _ of store.stream(query.eventsOfType('X'))) {
        // nothing
      }
    }).rejects.toBeInstanceOf(EventStoreError);
  });
});
