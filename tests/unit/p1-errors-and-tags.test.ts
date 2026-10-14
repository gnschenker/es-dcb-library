import { describe, it, expect, vi } from 'vitest';
import {
  InvalidTagError,
  LockTimeoutError,
  DeadlockError,
  SerializationFailureError,
  errorFromPg,
  EventStoreError,
  PostgresEventStore,
} from '../../src/index.js';
import { resolveFinalTags } from '../../src/store/resolve-event-tags.js';
import { UNTAGGED } from '../../src/types.js';

describe('errorFromPg (P1 #7)', () => {
  it('maps 55P03 to LockTimeoutError', () => {
    const err = errorFromPg({ code: '55P03', message: 'canceling statement due to lock timeout' });
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(err).toBeInstanceOf(EventStoreError);
  });

  it('maps 40P01 to DeadlockError', () => {
    expect(errorFromPg({ code: '40P01', message: 'deadlock detected' })).toBeInstanceOf(DeadlockError);
  });

  it('maps 40001 to SerializationFailureError', () => {
    expect(errorFromPg({ code: '40001', message: 'could not serialize' })).toBeInstanceOf(
      SerializationFailureError,
    );
  });

  it('leaves unknown errors as EventStoreError wrap only via caller', () => {
    const raw = Object.assign(new Error('syntax'), { code: '42601' });
    expect(errorFromPg(raw)).toBe(raw);
  });
});

describe('tag contract (P1 #6)', () => {
  it('allows slice-owned explicit tags without a registered extractor', () => {
    expect(resolveFinalTags({ type: 'SliceOwned', data: {}, tags: ['course:c1'] }, {})).toEqual([
      'course:c1',
    ]);
  });

  it('rejects empty and whitespace tags', () => {
    expect(() => resolveFinalTags({ type: 'E', data: {}, tags: [''] }, {})).toThrow(InvalidTagError);
    expect(() => resolveFinalTags({ type: 'E', data: {}, tags: ['  '] }, { E: UNTAGGED })).toThrow(
      InvalidTagError,
    );
  });

  it('rejects empty tags produced by an extractor', () => {
    expect(() =>
      resolveFinalTags({ type: 'E', data: {} }, { E: () => ['ok', ''] }),
    ).toThrow(InvalidTagError);
  });
});

describe('append maps lock timeout (P1 #7)', () => {
  it('rethrows LockTimeoutError after BEGIN + ROLLBACK', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || String(sql).startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        const err = Object.assign(new Error('lock timeout'), { code: '55P03' });
        throw err;
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const store = new PostgresEventStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
    });

    await expect(
      store.append(
        { type: 'E', data: {}, tags: ['t'] },
        { failIfEventsMatch: { items: [{ tags: ['t'] }] } },
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('ROLLBACK'))).toBe(true);
  });
});
