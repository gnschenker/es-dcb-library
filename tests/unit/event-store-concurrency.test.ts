import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { ConcurrencyError } from '../../src/errors.js';
import { query } from '../../src/query/query-object.js';

function makeStoredRow(pos = '1') {
  return {
    global_position: pos,
    event_id: '00000000-0000-0000-0000-000000000001',
    type: 'TestEvent',
    payload: {},
    metadata: null,
    occurred_at: new Date(),
  };
}

function makeMockClient(responses: unknown[]) {
  let i = 0;
  const calls: Array<[string, (unknown[] | undefined)?]> = [];
  const client = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      const resp = responses[i++];
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
    release: vi.fn(),
    _calls: calls,
  };
  return client;
}

describe('PostgresEventStore append() with advisory locks', () => {
  it('sets lock_timeout and statement_timeout when options provided', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '0' }], rowCount: 1 },
      { rows: [makeStoredRow()], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append(
      { type: 'X', payload: {} },
      { query: query.eventsOfType('X'), expectedVersion: 0n }
    );
    const sqls = client._calls.map(([sql]) => sql);
    expect(sqls.some(s => s.includes('lock_timeout'))).toBe(true);
    expect(sqls.some(s => s.includes('statement_timeout'))).toBe(true);
  });

  it('calls advisory lock before version check', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '0' }], rowCount: 1 },
      { rows: [makeStoredRow()], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append(
      { type: 'X', payload: {} },
      { query: query.eventsOfType('X'), expectedVersion: 0n }
    );
    const sqls = client._calls.map(([sql]) => sql);
    const lockIdx = sqls.findIndex(s => s.includes('pg_try_advisory_xact_lock'));
    const versionIdx = sqls.findIndex(s => s.includes('COALESCE(MAX'));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(versionIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(versionIdx);
  });

  it('throws ConcurrencyError and calls ROLLBACK when advisory lock not acquired', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: false }], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await expect(
      store.append({ type: 'X', payload: {} }, { query: query.eventsOfType('X'), expectedVersion: 0n })
    ).rejects.toBeInstanceOf(ConcurrencyError);
    const sqls = client._calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some(s => s.includes('INSERT'))).toBe(false);
  });

  it('proceeds with INSERT when version matches', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '5' }], rowCount: 1 },
      { rows: [makeStoredRow('6')], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    const result = await store.append(
      { type: 'X', payload: {} },
      { query: query.eventsOfType('X'), expectedVersion: 5n }
    );
    expect(result).toHaveLength(1);
    const sqls = client._calls.map(([sql]) => sql);
    expect(sqls).toContain('COMMIT');
  });

  it('throws ConcurrencyError with correct versions when version mismatches', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '5' }], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    const err = await store.append(
      { type: 'X', payload: {} },
      { query: query.eventsOfType('X'), expectedVersion: 3n }
    ).catch(e => e);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect((err as ConcurrencyError).expectedVersion).toBe(3n);
    expect((err as ConcurrencyError).actualVersion).toBe(5n);
  });

  it('calls ROLLBACK (not COMMIT) when version check fails', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '5' }], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await expect(
      store.append({ type: 'X', payload: {} }, { query: query.eventsOfType('X'), expectedVersion: 0n })
    ).rejects.toBeInstanceOf(ConcurrencyError);
    const sqls = client._calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('uses concurrencyQuery for advisory lock and version check when provided', async () => {
    const client = makeMockClient([
      {},
      {},
      {},
      { rows: [{ acquired: true }], rowCount: 1 },
      { rows: [{ max_pos: '0' }], rowCount: 1 },
      { rows: [makeStoredRow()], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    const mainQuery = query.eventsOfType('OrderCreated');
    const narrowQuery = query.eventsOfType('OrderCreated').where.key('customerId').equals('c1');
    await store.append(
      { type: 'OrderCreated', payload: { customerId: 'c1' } },
      { query: mainQuery, expectedVersion: 0n, concurrencyQuery: narrowQuery }
    );
    const versionCheckCall = client._calls.find(([sql]) => sql.includes('COALESCE(MAX'));
    expect(versionCheckCall).toBeDefined();
    expect(versionCheckCall![1]).toContain('{"customerId":"c1"}');
  });

  it('skips lock and version check when no options provided', async () => {
    const client = makeMockClient([
      {},
      { rows: [makeStoredRow()], rowCount: 1 },
      {},
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool;
    const store = new PostgresEventStore({ pool });
    await store.append({ type: 'X', payload: {} });
    const sqls = client._calls.map(([sql]) => sql);
    expect(sqls.some(s => s.includes('lock_timeout'))).toBe(false);
    expect(sqls.some(s => s.includes('pg_try_advisory_xact_lock'))).toBe(false);
    expect(sqls.some(s => s.includes('COALESCE(MAX'))).toBe(false);
  });
});
