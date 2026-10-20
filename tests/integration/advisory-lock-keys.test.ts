/**
 * B5 / AC6 — lock keys must collide when one writer's appended event
 * could match the other's failIfEventsMatch, even if the conditions
 * are written differently (e.g. `*:board:B1` vs `ChapterAdded:board:B1`).
 *
 * Real PostgreSQL (testcontainers). Local run:
 *   npm run test:integration -- tests/integration/advisory-lock-keys.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresEventStore,
  queryAll,
  queryItem,
  ConcurrencyError,
  DeadlockError,
  type Query,
  type StoredEvent,
} from '../../src/index.js';
import { applySchema } from '../../src/store/schema.js';

const AC6_RUNS = 200;

let pool: pg.Pool;
let store: PostgresEventStore;

function createPool(): pg.Pool {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL is not set — did globalSetup run?');
  }
  return new pg.Pool({ connectionString, max: 16 });
}

async function resetDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await applySchema(client);
    await client.query('TRUNCATE events RESTART IDENTITY CASCADE');
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  if (!pool) {
    pool = createPool();
    store = new PostgresEventStore({ pool });
  }
  await resetDatabase();
});

afterAll(async () => {
  await pool?.end();
});

type RaceOutcome = 'success' | 'conflict' | 'deadlock' | 'error';

async function raceConditionalWriters(
  failIfForSide: (side: 'A' | 'B') => Query,
  eventForSide: (side: 'A' | 'B') => { type: string; tags: string[] },
  countQuery: Query = queryAll(),
): Promise<{ outA: RaceOutcome; outB: RaceOutcome; events: StoredEvent[] }> {
  let ready = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = async (side: 'A' | 'B'): Promise<RaceOutcome> => {
    const q = failIfForSide(side);
    const { position } = await store.load(q);
    ready += 1;
    if (ready === 2) release();
    await barrier;
    try {
      const event = eventForSide(side);
      await store.append(
        { type: event.type, data: { side }, tags: event.tags },
        { failIfEventsMatch: q, after: position },
      );
      return 'success';
    } catch (err) {
      if (err instanceof ConcurrencyError) return 'conflict';
      if (err instanceof DeadlockError) return 'deadlock';
      return 'error';
    }
  };

  const [outA, outB] = await Promise.all([run('A'), run('B')]);
  const { events } = await store.load(countQuery);
  return { outA, outB, events };
}

function sideOf(event: StoredEvent): string {
  return String((event.data as { side?: unknown }).side ?? '');
}

function committedBefore(left: StoredEvent, right: StoredEvent): boolean {
  if (left.txId !== right.txId) return BigInt(left.txId) < BigInt(right.txId);
  return left.globalPosition < right.globalPosition;
}

/**
 * Writer A’s condition matches B’s event, but B’s condition does not match A’s.
 * Both succeeding is legal only when A committed first. A succeeding after B
 * committed is the 1.0.0 lock-key hole.
 */
function missedEarlierMatchingAppend(
  outA: RaceOutcome,
  events: StoredEvent[],
): boolean {
  if (outA !== 'success') return false;
  const eventA = events.find((e) => sideOf(e) === 'A');
  const eventB = events.find((e) => sideOf(e) === 'B');
  return eventA !== undefined && eventB !== undefined && committedBefore(eventB, eventA);
}

describe('advisory lock keys (B5 / AC6)', () => {
  it(
    'does not double-commit *:board vs ChapterAdded:board across 200 barrier races',
    async () => {
      let doubleCommits = 0;
      let unexpectedErrors = 0;

      for (let i = 0; i < AC6_RUNS; i += 1) {
        const board = `board:B${i}`;
        const { outA, outB, events } = await raceConditionalWriters(
          (side) =>
            side === 'A'
              ? queryItem({ tags: [board] })
              : queryItem({ types: ['ChapterAdded'], tags: [board] }),
          () => ({ type: 'ChapterAdded', tags: [board] }),
          queryItem({ tags: [board] }),
        );

        const successes = [outA, outB].filter((o) => o === 'success').length;
        if ([outA, outB].includes('error') || [outA, outB].includes('deadlock')) {
          unexpectedErrors += 1;
        }
        if (successes > 1 || events.length > 1) {
          doubleCommits += 1;
        }
      }

      expect(unexpectedErrors, 'unexpected non-concurrency errors').toBe(0);
      expect(doubleCommits, 'double-commits of first chapter on the same board').toBe(0);
    },
    180_000,
  );

  it('lets concurrent writers on disjoint tags both succeed', async () => {
    const { outA, outB, events } = await raceConditionalWriters(
      (side) =>
        side === 'A'
          ? queryItem({ tags: ['board:B1'] })
          : queryItem({ tags: ['board:B2'] }),
      (side) =>
        side === 'A'
          ? { type: 'ChapterAdded', tags: ['board:B1'] }
          : { type: 'ChapterAdded', tags: ['board:B2'] },
    );

    expect(outA).toBe('success');
    expect(outB).toBe('success');
    expect(events).toHaveLength(2);
  }, 60_000);

  it(
    'serializes a tagless type condition against a tagged append of that type',
    async () => {
      let missed = 0;
      let unexpectedErrors = 0;

      for (let i = 0; i < AC6_RUNS; i += 1) {
        const type = `ChapterAdded_${i}`;
        const tagged = `board:B${i}`;
        const other = `other:${i}`;
        const { outA, outB, events } = await raceConditionalWriters(
          (side) =>
            side === 'A' ? queryItem({ types: [type] }) : queryItem({ tags: [tagged] }),
          (side) =>
            side === 'A'
              ? { type, tags: [other] }
              : { type, tags: [tagged] },
          queryItem({ types: [type] }),
        );

        if ([outA, outB].includes('error') || [outA, outB].includes('deadlock')) {
          unexpectedErrors += 1;
        }
        if (missedEarlierMatchingAppend(outA, events)) {
          missed += 1;
        }
      }

      expect(unexpectedErrors, 'unexpected non-concurrency errors').toBe(0);
      expect(
        missed,
        'tagless type writer succeeded after a tagged append of that type',
      ).toBe(0);
    },
    180_000,
  );

  it(
    'serializes a match-all condition against any concurrent append',
    async () => {
      let missed = 0;
      let unexpectedErrors = 0;

      for (let i = 0; i < AC6_RUNS; i += 1) {
        await resetDatabase();
        const { outA, outB, events } = await raceConditionalWriters(
          (side) => (side === 'A' ? queryAll() : queryItem({ tags: [`board:B${i}`] })),
          (side) =>
            side === 'A'
              ? { type: 'Anything', tags: [`other:${i}`] }
              : { type: 'ChapterAdded', tags: [`board:B${i}`] },
        );

        if ([outA, outB].includes('error') || [outA, outB].includes('deadlock')) {
          unexpectedErrors += 1;
        }
        if (missedEarlierMatchingAppend(outA, events)) {
          missed += 1;
        }
      }

      expect(unexpectedErrors, 'unexpected non-concurrency errors').toBe(0);
      expect(missed, 'match-all writer succeeded after a concurrent append').toBe(0);
    },
    180_000,
  );

  it('does not deadlock when two writers acquire reversed lock-key sets', async () => {
    const { outA, outB, events } = await raceConditionalWriters(
      (side) =>
        side === 'A'
          ? queryItem({ types: ['TypeZ'], tags: ['tag-high', 'extra-a'] })
          : queryItem({ types: ['TypeY'], tags: ['tag-low', 'extra-b'] }),
      (side) =>
        side === 'A'
          ? { type: 'TypeA', tags: ['tag-low'] }
          : { type: 'TypeB', tags: ['tag-high'] },
    );

    expect([outA, outB].includes('deadlock')).toBe(false);
    expect([outA, outB].includes('error')).toBe(false);
    expect(outA).toBe('success');
    expect(outB).toBe('success');
    expect(events).toHaveLength(2);
  }, 60_000);
});
