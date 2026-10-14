import { describe, it, expect, vi } from 'vitest';
import { PostgresEventStore, queryItem, MissingTagExtractorError, EmptyBatchError } from '../../src/index.js';

function mockClient(query: ReturnType<typeof vi.fn>) {
  return { query, release: vi.fn() };
}

describe('append batch validation (P0 #2)', () => {
  it('rejects an empty array without opening a connection', async () => {
    const connect = vi.fn();
    const store = new PostgresEventStore({ pool: { connect } as never });

    await expect(store.append([])).rejects.toBeInstanceOf(EmptyBatchError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects an empty array even when a condition is supplied', async () => {
    const connect = vi.fn();
    const store = new PostgresEventStore({ pool: { connect } as never });

    await expect(
      store.append([], { failIfEventsMatch: queryItem({ tags: ['t'] }) }),
    ).rejects.toBeInstanceOf(EmptyBatchError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('prevalidates the whole batch: invalid later event does not connect', async () => {
    const connect = vi.fn();
    const store = new PostgresEventStore({ pool: { connect } as never });

    await expect(
      store.append([
        { type: 'Good', data: {}, tags: ['ok'] },
        { type: 'Bad', data: {} },
      ]),
    ).rejects.toBeInstanceOf(MissingTagExtractorError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rolls back after BEGIN when a later error is a known error type', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        throw new MissingTagExtractorError('LockPath', 'injected after BEGIN');
      }
      return { rows: [] };
    });
    const client = mockClient(query);
    const store = new PostgresEventStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
    });

    await expect(
      store.append(
        { type: 'E', data: {}, tags: ['t'] },
        { failIfEventsMatch: queryItem({ tags: ['t'] }) },
      ),
    ).rejects.toBeInstanceOf(MissingTagExtractorError);

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('ROLLBACK'))).toBe(true);
  });
});
