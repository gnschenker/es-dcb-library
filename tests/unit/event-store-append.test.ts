import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { EventStoreError } from '../../src/errors.js';

// Mock client that records calls
function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
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

describe('PostgresEventStore.append() (unit)', () => {
  it('returns array of one StoredEvent for a single NewEvent', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [makeRow({ global_position: '1' })], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    const result = await store.append({ type: 'TestEvent', payload: { x: 1 } });
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('TestEvent');
    expect(result[0]!.globalPosition).toBe(1n);
  });

  it('returns StoredEvents in insert order for multiple events', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [makeRow({ global_position: '1' })], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [makeRow({ global_position: '2' })], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [makeRow({ global_position: '3' })], rowCount: 1 })
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    const result = await store.append([
      { type: 'A', payload: {} },
      { type: 'B', payload: {} },
      { type: 'C', payload: {} },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map(e => e.globalPosition)).toEqual([1n, 2n, 3n]);
  });

  it('passes null for metadata when metadata is undefined', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 })
        .mockResolvedValueOnce({}), // COMMIT
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'X', payload: {} }); // no metadata
    // The INSERT call is the second query call (index 1)
    const insertCall = mockClient.query.mock.calls[1]!;
    const params = insertCall[1] as unknown[];
    expect(params[2]).toBeNull(); // metadata param should be null
  });

  it('passes metadata object to INSERT when provided', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [makeRow({ metadata: { key: 'val' } })], rowCount: 1 })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'X', payload: {}, metadata: { key: 'val' } });
    const insertCall = mockClient.query.mock.calls[1]!;
    const params = insertCall[1] as unknown[];
    expect(params[2]).toEqual({ key: 'val' });
  });

  it('uses RETURNING in INSERT SQL', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'X', payload: {} });
    const insertSql = mockClient.query.mock.calls[1]![0] as string;
    expect(insertSql).toMatch(/RETURNING/i);
  });

  it('calls BEGIN and COMMIT exactly once per append', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 })
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'X', payload: {} });
    const allSql = mockClient.query.mock.calls.map(c => String(c[0]));
    expect(allSql.filter(s => s === 'BEGIN')).toHaveLength(1);
    expect(allSql.filter(s => s === 'COMMIT')).toHaveLength(1);
  });

  it('calls ROLLBACK and throws EventStoreError on INSERT failure', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('constraint violation')) // INSERT fails
        .mockResolvedValueOnce({}), // ROLLBACK
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(mockClient) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await expect(store.append({ type: 'X', payload: {} })).rejects.toBeInstanceOf(EventStoreError);
    const allSql = mockClient.query.mock.calls.map(c => String(c[0]));
    expect(allSql).toContain('ROLLBACK');
    expect(allSql).not.toContain('COMMIT');
  });
});
