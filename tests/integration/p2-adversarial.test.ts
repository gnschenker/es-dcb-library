/**
 * P2 #8 — adversarial PostgreSQL tests: overlapping predicates, rollback gaps,
 * pool reuse, large histories, and high-contention writers.
 *
 * Local run (Docker required):
 *   npm run test:integration -- tests/integration/p2-adversarial.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresEventStore,
  queryAll,
  queryItem,
  ConcurrencyError,
  EmptyBatchError,
  MissingTagExtractorError,
  type Query,
} from '../../src/index.js';
import { applySchema } from '../../src/store/schema.js';

const SHARED = 'p2:shared';
const STUDENT = 'p2:student:s1';
const COURSE = 'p2:course:c1';
const DISJOINT_A = 'p2:disjoint-a';
const DISJOINT_B = 'p2:disjoint-b';

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

async function raceConditionalWriters(
  failIfForSide: (side: 'A' | 'B') => Query,
  eventForSide: (side: 'A' | 'B') => { type: string; tags: string[] },
): Promise<{ outA: string; outB: string; count: number }> {
  let ready = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = async (side: 'A' | 'B'): Promise<'success' | 'conflict' | 'error'> => {
    const q = failIfForSide(side);
    const { position } = await store.load(q);
    ready += 1;
    if (ready === 2) release();
    await barrier;
    try {
      const event = eventForSide(side);
      await store.append({ type: event.type, data: { side }, tags: event.tags }, {
        failIfEventsMatch: q,
        after: position,
      });
      return 'success';
    } catch (err) {
      if (err instanceof ConcurrencyError) return 'conflict';
      return 'error';
    }
  };

  const [outA, outB] = await Promise.all([run('A'), run('B')]);
  const { events } = await store.load(queryAll());
  return { outA, outB, count: events.length };
}

describe('P2 #8 — overlapping dynamic predicates', () => {
  it('serializes multi-tag AND writers that match each other\'s new event', async () => {
    const { outA, outB, count } = await raceConditionalWriters(
      (side) =>
        side === 'A'
          ? queryItem({ types: ['StudentEnrolled'], tags: [STUDENT] })
          : queryItem({ types: ['StudentEnrolled'], tags: [COURSE] }),
      () => ({ type: 'StudentEnrolled', tags: [STUDENT, COURSE] }),
    );

    expect([outA, outB].includes('error')).toBe(false);
    expect([outA, outB].filter((o) => o === 'success')).toHaveLength(1);
    expect(count).toBe(1);
  }, 60_000);

  it('serializes a wildcard-tag condition against a typed condition on the same tag', async () => {
    const { outA, outB, count } = await raceConditionalWriters(
      (side) =>
        side === 'A'
          ? queryItem({ tags: [SHARED] })
          : queryItem({ types: ['Typed'], tags: [SHARED] }),
      (side) =>
        side === 'A'
          ? { type: 'Wildcard', tags: [SHARED] }
          : { type: 'Typed', tags: [SHARED] },
    );

    expect([outA, outB].includes('error')).toBe(false);
    expect([outA, outB].filter((o) => o === 'success')).toHaveLength(1);
    expect(count).toBe(1);
  }, 60_000);

  it('lets concurrent writers on disjoint tags both succeed', async () => {
    const { outA, outB, count } = await raceConditionalWriters(
      (side) =>
        side === 'A'
          ? queryItem({ tags: [DISJOINT_A] })
          : queryItem({ tags: [DISJOINT_B] }),
      (side) =>
        side === 'A'
          ? { type: 'OnlyA', tags: [DISJOINT_A] }
          : { type: 'OnlyB', tags: [DISJOINT_B] },
    );

    expect(outA).toBe('success');
    expect(outB).toBe('success');
    expect(count).toBe(2);
  }, 60_000);
});

describe('P2 #8 — conditional vs unconditional writer', () => {
  /**
   * Unconditional append does not acquire DCB locks (documented on EventStore.append).
   * A concurrent unconditional writer can therefore commit beside a conditional one.
   * This test records that residual risk; it does not change production code.
   */
  it('records whether an unconditional writer can commit beside a conditional writer', async () => {
    const trials = 8;
    let dualSuccess = 0;
    let unconditionalAlwaysOk = true;

    for (let i = 0; i < trials; i += 1) {
      await resetDatabase();
      const q = queryItem({ tags: [SHARED] });
      const { position } = await store.load(q);

      let ready = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      const conditional = (async () => {
        ready += 1;
        if (ready === 2) release();
        await barrier;
        return store.append(
          { type: 'Cond', data: { i }, tags: [SHARED] },
          { failIfEventsMatch: q, after: position },
        );
      })();

      const unconditional = (async () => {
        ready += 1;
        if (ready === 2) release();
        await barrier;
        return store.append({ type: 'Uncond', data: { i }, tags: [SHARED] });
      })();

      const [condResult, uncondResult] = await Promise.allSettled([conditional, unconditional]);
      if (uncondResult.status !== 'fulfilled') {
        unconditionalAlwaysOk = false;
      }
      if (condResult.status === 'fulfilled' && uncondResult.status === 'fulfilled') {
        dualSuccess += 1;
      }
    }

    expect(unconditionalAlwaysOk).toBe(true);
    // Observational: dual success is the documented residual risk of omitting `condition`.
    expect(dualSuccess).toBeGreaterThanOrEqual(0);
    // eslint-disable-next-line no-console
    console.log(`P2 FLAG: unconditional+conditional dual success in ${dualSuccess}/${trials} trials`);
  }, 60_000);
});

describe('P2 #8 — out-of-order commits, rollback gaps, pool reuse', () => {
  it('load() omits an in-flight lower position until that transaction commits', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const q = queryItem({ tags: [SHARED] });

    try {
      await clientA.query('BEGIN');
      await clientA.query(
        `INSERT INTO events (type, data, tags) VALUES ($1, $2::jsonb, $3)`,
        ['Late', JSON.stringify({ n: 1 }), [SHARED]],
      );

      await clientB.query('BEGIN');
      await clientB.query(
        `INSERT INTO events (type, data, tags) VALUES ($1, $2::jsonb, $3)`,
        ['Early', JSON.stringify({ n: 2 }), [SHARED]],
      );
      await clientB.query('COMMIT');

      const atLoad = await store.load(q);
      expect(atLoad.events.map((e) => e.type)).not.toContain('Late');
      expect(atLoad.position.readXmin).toBeDefined();

      await clientA.query('COMMIT');

      const after = await store.load(q);
      expect(after.events.map((e) => e.type).sort()).toEqual(['Early', 'Late']);
    } finally {
      await clientA.query('ROLLBACK').catch(() => undefined);
      await clientB.query('ROLLBACK').catch(() => undefined);
      clientA.release();
      clientB.release();
    }
  }, 60_000);

  it('a rolled-back insert burns a sequence value but does not block load or append', async () => {
    const first = await store.append({ type: 'First', data: {}, tags: [SHARED] });
    const pos1 = first[0]!.globalPosition;

    const burner = await pool.connect();
    try {
      await burner.query('BEGIN');
      await burner.query(
        `INSERT INTO events (type, data, tags) VALUES ($1, $2::jsonb, $3)`,
        ['Burned', JSON.stringify({}), [SHARED]],
      );
      await burner.query('ROLLBACK');
    } finally {
      burner.release();
    }

    const q = queryItem({ tags: [SHARED] });
    const loaded = await store.load(q);
    expect(loaded.events.map((e) => e.type)).toEqual(['First']);

    const second = await store.append(
      { type: 'Second', data: {}, tags: [SHARED] },
      { failIfEventsMatch: q, after: loaded.position },
    );
    expect(second[0]!.globalPosition).toBeGreaterThan(pos1 + 1n);

    const after = await store.load(q);
    expect(after.events.map((e) => e.type)).toEqual(['First', 'Second']);
  }, 60_000);

  it('reuses the pool after EmptyBatchError, MissingTagExtractorError, and mid-batch SQL failure', async () => {
    await expect(store.append([])).rejects.toBeInstanceOf(EmptyBatchError);
    await expect(
      store.append([
        { type: 'Ok', data: {}, tags: [SHARED] },
        { type: 'NoTags', data: {} },
      ]),
    ).rejects.toBeInstanceOf(MissingTagExtractorError);
    await expect(
      store.append([
        { type: 'Ok', data: {}, tags: [SHARED] },
        { type: 'x'.repeat(300), data: {}, tags: [SHARED] },
      ]),
    ).rejects.toThrow();

    const stored = await store.append({ type: 'Recovered', data: { ok: true }, tags: [SHARED] });
    expect(stored).toHaveLength(1);

    const { events } = await store.load(queryAll());
    expect(events.map((e) => e.type)).toEqual(['Recovered']);
  });
});

describe('P2 #8 — large histories and payload fidelity', () => {
  it('load and committed stream return the same ordered history of 600 events', async () => {
    const batchSize = 50;
    const total = 600;
    for (let i = 0; i < total; i += batchSize) {
      const batch = Array.from({ length: batchSize }, (_, j) => {
        const n = i + j;
        return {
          type: n % 2 === 0 ? 'Even' : 'Odd',
          data: { n },
          tags: [SHARED, n % 2 === 0 ? 'p2:even' : 'p2:odd'],
        };
      });
      await store.append(batch);
    }

    const loaded = await store.load(queryItem({ tags: [SHARED] }));
    expect(loaded.events).toHaveLength(total);
    expect(loaded.position.globalPosition).toBe(loaded.events[total - 1]!.globalPosition);
    expect(loaded.position.txId).toBe(loaded.events[total - 1]!.txId);
    expect(loaded.position.readXmin).toBeDefined();

    for (let i = 1; i < loaded.events.length; i += 1) {
      const prev = loaded.events[i - 1]!;
      const cur = loaded.events[i]!;
      const txCmp = BigInt(prev.txId) === BigInt(cur.txId)
        ? prev.globalPosition < cur.globalPosition
        : BigInt(prev.txId) < BigInt(cur.txId);
      expect(txCmp).toBe(true);
    }

    const streamed: typeof loaded.events = [];
    for await (const event of store.stream(queryItem({ tags: [SHARED] }), {
      committedOnly: true,
      batchSize: 40,
    })) {
      streamed.push(event);
    }
    expect(streamed.map((e) => e.eventId)).toEqual(loaded.events.map((e) => e.eventId));
  }, 60_000);

  it('stale readXmin on an advanced cursor is a false conflict (usage footgun)', async () => {
    const q = queryItem({ tags: [SHARED] });
    const empty = await store.load(q);
    const [first] = await store.append(
      { type: 'First', data: {}, tags: [SHARED] },
      { failIfEventsMatch: q, after: empty.position },
    );
    const [second] = await store.append(
      { type: 'Second', data: {}, tags: [SHARED] },
      {
        failIfEventsMatch: q,
        after: { txId: first!.txId, globalPosition: first!.globalPosition },
      },
    );

    // Mixing the original load's readXmin with a later position treats First as a late commit.
    await expect(
      store.append(
        { type: 'Third', data: {}, tags: [SHARED] },
        {
          failIfEventsMatch: q,
          after: {
            txId: second!.txId,
            globalPosition: second!.globalPosition,
            ...(empty.position.readXmin !== undefined
              ? { readXmin: empty.position.readXmin }
              : {}),
          },
        },
      ),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    const fresh = await store.load(q);
    await expect(
      store.append(
        { type: 'Third', data: {}, tags: [SHARED] },
        { failIfEventsMatch: q, after: fresh.position },
      ),
    ).resolves.toHaveLength(1);
  });

  it('preserves payload and metadata bytes with no transformation', async () => {
    const data = { nested: { n: 1 }, flag: true, note: 'unaltered' };
    const metadata = { source: 'p2-adversarial', version: 7 };
    const [stored] = await store.append({
      type: 'Preserved',
      data,
      metadata,
      tags: [SHARED],
    });

    expect(stored!.data).toEqual(data);
    expect(stored!.metadata).toEqual(metadata);

    const { events } = await store.load(queryItem({ types: ['Preserved'] }));
    expect(events[0]!.data).toEqual(data);
    expect(events[0]!.metadata).toEqual(metadata);
  });
});

describe('P2 #8 — high-contention same-stream writers', () => {
  it('exactly one of eight concurrent conditional appends succeeds', async () => {
    const q = queryItem({ tags: [SHARED] });
    const { position } = await store.load(q);

    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writers = Array.from({ length: 8 }, (_, i) =>
      (async (): Promise<'success' | 'conflict' | 'error'> => {
        ready += 1;
        if (ready === 8) release();
        await barrier;
        try {
          await store.append(
            { type: 'Contended', data: { i }, tags: [SHARED] },
            { failIfEventsMatch: q, after: position },
          );
          return 'success';
        } catch (err) {
          if (err instanceof ConcurrencyError) return 'conflict';
          return 'error';
        }
      })(),
    );

    const outcomes = await Promise.all(writers);
    expect(outcomes.filter((o) => o === 'error')).toHaveLength(0);
    expect(outcomes.filter((o) => o === 'success')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'conflict')).toHaveLength(7);

    const { events } = await store.load(q);
    expect(events).toHaveLength(1);
  }, 60_000);
});
