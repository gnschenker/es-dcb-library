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
  LockTimeoutError,
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
    const { outA, outB, events } = await raceWithFirstLockHold(
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

  it('serializes two type-only conditions on the same type', async () => {
    const { outA, outB, events } = await raceHeldAfterAllLocks(
      () => queryItem({ types: ['SameType'] }),
      (side) =>
        side === 'A'
          ? { type: 'SameType', tags: ['w1'] }
          : { type: 'SameType', tags: ['w2'] },
    );

    expect([outA, outB].includes('error')).toBe(false);
    expect([outA, outB].includes('deadlock')).toBe(false);
    expect([outA, outB].filter((o) => o === 'success')).toHaveLength(1);
    expect([outA, outB].filter((o) => o === 'conflict')).toHaveLength(1);
    expect(events).toHaveLength(1);
  }, 60_000);

  it('does not block a tagless type condition against a different type', async () => {
    const overlap = await raceHeldAfterFirstLock(
      (side) =>
        side === 'A' ? queryItem({ types: ['TypeFoo'] }) : queryItem({ types: ['TypeBar'] }),
      (side) =>
        side === 'A'
          ? { type: 'TypeFoo', tags: ['foo'] }
          : { type: 'TypeBar', tags: ['bar'] },
    );

    expect(overlap.bFinishedWhileAHeld).toBe(true);
    expect(overlap.outA).toBe('success');
    expect(overlap.outB).toBe('success');
    expect(overlap.events).toHaveLength(2);
  }, 60_000);

  it('runs disjoint-tag conditional appends in parallel', async () => {
    const overlap = await raceHeldAfterFirstLock(
      (side) =>
        side === 'A' ? queryItem({ tags: ['board:B1'] }) : queryItem({ tags: ['board:B2'] }),
      (side) =>
        side === 'A'
          ? { type: 'ChapterAdded', tags: ['board:B1'] }
          : { type: 'ChapterAdded', tags: ['board:B2'] },
    );

    expect(overlap.bFinishedWhileAHeld).toBe(true);
    expect(overlap.outA).toBe('success');
    expect(overlap.outB).toBe('success');
    expect(overlap.events).toHaveLength(2);
  }, 60_000);

  it('lets an unconditional append commit while a conditional writer holds locks', async () => {
    const q = queryItem({ tags: ['board:B1'] });
    const { position } = await store.load(q);

    let afterLocks!: () => void;
    const heldAfterLocks = new Promise<void>((resolve) => {
      afterLocks = resolve;
    });
    let releaseA!: () => void;
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const conditionalStore = new PostgresEventStore({
      pool,
      runAcquireLocks: async (pairCount, acquireNext) => {
        for (let i = 0; i < pairCount; i += 1) {
          await acquireNext();
        }
        afterLocks();
        await aMayFinish;
      },
    });

    const condPromise = outcomeOf(
      conditionalStore.append(
        { type: 'ChapterAdded', data: { side: 'A' }, tags: ['board:B1'] },
        { failIfEventsMatch: q, after: position },
      ),
    );

    await heldAfterLocks;
    await store.append({ type: 'Uncond', data: { side: 'B' }, tags: ['board:B1'] });
    releaseA();

    const outA = await condPromise;
    expect(outA).toBe('conflict');
    const { events } = await store.load(queryAll());
    expect(events.map((e) => e.type)).toEqual(['Uncond']);
  }, 60_000);
});

/**
 * Both writers take their first lock and wait; only then do they continue.
 * Insertion-order acquire deadlocks on reversed key sets; sorted acquire does not.
 */
function createFirstLockHoldScheduler(): (
  pairCount: number,
  acquireNext: () => Promise<void>,
) => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (pairCount, acquireNext) => {
    await acquireNext();
    arrived += 1;
    if (arrived === 2) release();
    await gate;
    for (let i = 1; i < pairCount; i += 1) {
      await acquireNext();
    }
  };
}

async function outcomeOf(work: Promise<unknown>): Promise<RaceOutcome> {
  try {
    await work;
    return 'success';
  } catch (err) {
    if (err instanceof ConcurrencyError) return 'conflict';
    if (err instanceof DeadlockError || err instanceof LockTimeoutError) return 'deadlock';
    return 'error';
  }
}

async function raceWithFirstLockHold(
  failIfForSide: (side: 'A' | 'B') => Query,
  eventForSide: (side: 'A' | 'B') => { type: string; tags: string[] },
): Promise<{ outA: RaceOutcome; outB: RaceOutcome; events: StoredEvent[] }> {
  const runAcquireLocks = createFirstLockHoldScheduler();
  const storeA = new PostgresEventStore({ pool, runAcquireLocks });
  const storeB = new PostgresEventStore({ pool, runAcquireLocks });

  const run = async (side: 'A' | 'B', s: PostgresEventStore): Promise<RaceOutcome> => {
    const q = failIfForSide(side);
    const { position } = await s.load(q);
    const event = eventForSide(side);
    return outcomeOf(
      s.append({ type: event.type, data: { side }, tags: event.tags }, {
        failIfEventsMatch: q,
        after: position,
      }),
    );
  };

  const [outA, outB] = await Promise.all([run('A', storeA), run('B', storeB)]);
  const { events } = await store.load(queryAll());
  return { outA, outB, events };
}

/** A takes every lock and holds the transaction; B must wait, then one conflicts. */
async function raceHeldAfterAllLocks(
  failIfForSide: (side: 'A' | 'B') => Query,
  eventForSide: (side: 'A' | 'B') => { type: string; tags: string[] },
): Promise<{ outA: RaceOutcome; outB: RaceOutcome; events: StoredEvent[] }> {
  let aHasLocks!: () => void;
  const held = new Promise<void>((resolve) => {
    aHasLocks = resolve;
  });
  let releaseA!: () => void;
  const aMayFinish = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const storeA = new PostgresEventStore({
    pool,
    runAcquireLocks: async (pairCount, acquireNext) => {
      for (let i = 0; i < pairCount; i += 1) {
        await acquireNext();
      }
      aHasLocks();
      await aMayFinish;
    },
  });
  const storeB = new PostgresEventStore({ pool });

  const run = async (side: 'A' | 'B', s: PostgresEventStore): Promise<RaceOutcome> => {
    const q = failIfForSide(side);
    const { position } = await s.load(q);
    const event = eventForSide(side);
    return outcomeOf(
      s.append({ type: event.type, data: { side }, tags: event.tags }, {
        failIfEventsMatch: q,
        after: position,
      }),
    );
  };

  const aPromise = run('A', storeA);
  await held;
  const bPromise = run('B', storeB);
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseA();
  const [outA, outB] = await Promise.all([aPromise, bPromise]);
  const { events } = await store.load(queryAll());
  return { outA, outB, events };
}

/** A holds after the first lock; B is allowed to run to completion before A continues. */
async function raceHeldAfterFirstLock(
  failIfForSide: (side: 'A' | 'B') => Query,
  eventForSide: (side: 'A' | 'B') => { type: string; tags: string[] },
): Promise<{
  outA: RaceOutcome;
  outB: RaceOutcome;
  events: StoredEvent[];
  bFinishedWhileAHeld: boolean;
}> {
  let aHasFirst!: () => void;
  const held = new Promise<void>((resolve) => {
    aHasFirst = resolve;
  });
  let releaseA!: () => void;
  const aMayFinish = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const storeA = new PostgresEventStore({
    pool,
    runAcquireLocks: async (pairCount, acquireNext) => {
      await acquireNext();
      aHasFirst();
      await aMayFinish;
      for (let i = 1; i < pairCount; i += 1) {
        await acquireNext();
      }
    },
  });
  const storeB = new PostgresEventStore({ pool });

  const run = async (side: 'A' | 'B', s: PostgresEventStore): Promise<RaceOutcome> => {
    const q = failIfForSide(side);
    const { position } = await s.load(q);
    const event = eventForSide(side);
    return outcomeOf(
      s.append({ type: event.type, data: { side }, tags: event.tags }, {
        failIfEventsMatch: q,
        after: position,
      }),
    );
  };

  const aPromise = run('A', storeA);
  await held;
  const outB = await run('B', storeB);
  const bFinishedWhileAHeld = true;
  releaseA();
  const outA = await aPromise;
  const { events } = await store.load(queryAll());
  return { outA, outB, events, bFinishedWhileAHeld };
}
