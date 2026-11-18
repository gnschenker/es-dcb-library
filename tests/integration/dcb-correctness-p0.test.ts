/**
 * Adversarial P0 DCB correctness (locks + commit-order-safe load/append positions).
 *
 * Local run (Docker required): npm run test:integration -- tests/integration/dcb-correctness-p0.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  PostgresEventStore,
  queryItem,
  ConcurrencyError,
  type StreamCursor,
  type Query,
  type StoredEvent,
} from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

const STREAM_TAG = 'dcb-p0:shared-stream';
const TAG_A = 'dcb-p0:tag-a';
const TAG_B = 'dcb-p0:tag-b';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  await resetDatabase(pool);
  store = new PostgresEventStore({
    pool,
    tagExtractors: {
      EventAlpha: () => [STREAM_TAG],
      EventBeta: () => [STREAM_TAG],
      FollowUp: () => [STREAM_TAG],
      TxHoleA: () => [STREAM_TAG],
      TxHoleB: () => [STREAM_TAG],
      OnlyA: () => [TAG_A],
      OnlyB: () => [TAG_B],
    },
  });
});

afterAll(async () => {
  await pool?.end();
});

/**
 * Two writers load, wait for each other, then append concurrently.
 * Each writer loads with the same query it passes as `failIfEventsMatch`
 * (the DCB contract: the condition covers exactly what the decision read).
 */
async function runDualWriterRace(
  failIfForSide: (side: 'A' | 'B') => Query,
  typeForSide: (side: 'A' | 'B') => string,
  streamQuery: Query,
): Promise<{ outA: string; outB: string; eventCount: number; events: StoredEvent[] }> {
  let ready = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const positions: { A: StreamCursor; B: StreamCursor } = {
    A: { txId: '0', globalPosition: 0n },
    B: { txId: '0', globalPosition: 0n },
  };

  const runWriter = async (side: 'A' | 'B'): Promise<'success' | 'conflict' | 'error'> => {
    const { position } = await store.load(failIfForSide(side));
    positions[side] = position;
    ready += 1;
    if (ready === 2) release();
    await barrier;

    try {
      await store.append(
        { type: typeForSide(side), data: { side } },
        { failIfEventsMatch: failIfForSide(side), after: positions[side] },
      );
      return 'success';
    } catch (err) {
      if (err instanceof ConcurrencyError) return 'conflict';
      return 'error';
    }
  };

  const [outA, outB] = await Promise.all([runWriter('A'), runWriter('B')]);
  const { events } = await store.load(streamQuery);
  return { outA, outB, eventCount: events.length, events };
}

describe('DCB correctness — P0 adversarial', () => {
  describe('P0 #1 — advisory locks on condition ∪ appended events', () => {
    const queryA = () => queryItem({ types: ['EventAlpha'], tags: [STREAM_TAG] });
    const queryB = () => queryItem({ types: ['EventBeta'], tags: [STREAM_TAG] });
    const streamQuery = () => queryItem({ tags: [STREAM_TAG] });

    it(
      'independent decisions on a shared tag both succeed when neither append matches the other condition',
      async () => {
        // A reads/checks only EventAlpha and appends EventAlpha; B likewise for EventBeta.
        // Neither append invalidates the other decision, so DCB lets both through.
        const { outA, outB, eventCount } = await runDualWriterRace(
          (side) => (side === 'A' ? queryA() : queryB()),
          (side) => (side === 'A' ? 'EventAlpha' : 'EventBeta'),
          streamQuery(),
        );

        expect(outA).toBe('success');
        expect(outB).toBe('success');
        expect(eventCount).toBe(2);
      },
      60_000,
    );

    it(
      "a writer whose append matches the other writer's condition cannot slip past it",
      async () => {
        // B's condition (EventBeta) does not cover EventAlpha, but B appends EventAlpha,
        // which A's condition covers. Locks on appended (type, tag) pairs serialize them:
        // A may only succeed if its event was committed before B's.
        for (let round = 0; round < 5; round++) {
          await resetDatabase(pool);
          const { outA, outB, events } = await runDualWriterRace(
            (side) => (side === 'A' ? queryA() : queryB()),
            () => 'EventAlpha',
            streamQuery(),
          );

          expect(outB).toBe('success');
          if (outA === 'success') {
            const byWriter = (side: string) => events.find((e) => (e.data as { side: string }).side === side)!;
            expect(byWriter('A').globalPosition).toBeLessThan(byWriter('B').globalPosition);
          } else {
            expect(outA).toBe('conflict');
          }
        }
      },
      60_000,
    );

    it(
      'stream-level failIf also serializes cross-type writers on the same tag',
      async () => {
        const { outA, outB, eventCount } = await runDualWriterRace(
          () => streamQuery(),
          (side) => (side === 'A' ? 'EventAlpha' : 'EventBeta'),
          streamQuery(),
        );

        const successes = [outA, outB].filter((o) => o === 'success');
        expect(successes.length).toBeLessThanOrEqual(1);
        expect(eventCount).toBeLessThanOrEqual(1);
      },
      60_000,
    );

    it('concurrent appends on disjoint tags both succeed', async () => {
      const qA = queryItem({ types: ['OnlyA'], tags: [TAG_A] });
      const qB = queryItem({ types: ['OnlyB'], tags: [TAG_B] });

      let ready = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      const runWriter = async (q: Query, type: string): Promise<'success' | 'conflict' | 'error'> => {
        const { position } = await store.load(q);
        ready += 1;
        if (ready === 2) release();
        await barrier;
        try {
          await store.append({ type, data: {} }, { failIfEventsMatch: q, after: position });
          return 'success';
        } catch (err) {
          if (err instanceof ConcurrencyError) return 'conflict';
          return 'error';
        }
      };

      const [outA, outB] = await Promise.all([runWriter(qA, 'OnlyA'), runWriter(qB, 'OnlyB')]);

      expect(outA).toBe('success');
      expect(outB).toBe('success');
      const aEvents = await store.load(qA);
      const bEvents = await store.load(qB);
      expect(aEvents.events).toHaveLength(1);
      expect(bEvents.events).toHaveLength(1);
    });
  });

  describe('typed conditions ignore other event types on the same tag', () => {
    const queryA = () => queryItem({ types: ['EventAlpha'], tags: [STREAM_TAG] });

    it('an older event of another type on the tag does not block a typed condition', async () => {
      // Regression: v1.0.1 rejected this append forever, because EventBeta sits after the
      // last EventAlpha (the position load() returns) and the single-tag check ignored types.
      await store.append({ type: 'EventAlpha', data: { n: 1 } });
      await store.append({ type: 'EventBeta', data: { n: 2 } });

      const { position } = await store.load(queryA());
      await expect(
        store.append({ type: 'EventAlpha', data: { n: 3 } }, { failIfEventsMatch: queryA(), after: position }),
      ).resolves.toHaveLength(1);
    });

    it('a matching event appended after load() still fails the condition', async () => {
      await store.append({ type: 'EventAlpha', data: { n: 1 } });
      await store.append({ type: 'EventBeta', data: { n: 2 } });
      const { position } = await store.load(queryA());

      await store.append({ type: 'EventAlpha', data: { n: 3 } });
      await expect(
        store.append({ type: 'EventAlpha', data: { n: 4 } }, { failIfEventsMatch: queryA(), after: position }),
      ).rejects.toBeInstanceOf(ConcurrencyError);
    });
  });

  describe('P0 #3 — load() position is commit-order-safe', () => {
    it(
      'conditional append is rejected when an older position commits after load()',
      async () => {
        const clientA = await pool.connect();
        const clientB = await pool.connect();
        const streamQuery = queryItem({ tags: [STREAM_TAG] });

        try {
          await clientA.query('BEGIN');
          await clientA.query(
            `INSERT INTO events (type, data, tags) VALUES ($1, $2::jsonb, $3)`,
            ['TxHoleA', JSON.stringify({ hole: 'A' }), [STREAM_TAG]],
          );

          await clientB.query('BEGIN');
          await clientB.query(
            `INSERT INTO events (type, data, tags) VALUES ($1, $2::jsonb, $3)`,
            ['TxHoleB', JSON.stringify({ hole: 'B' }), [STREAM_TAG]],
          );
          await clientB.query('COMMIT');

          const { events: eventsAtLoad, position } = await store.load(streamQuery);

          await clientA.query('COMMIT');

          const afterHole = await store.load(streamQuery);
          expect(afterHole.events.some((e) => e.type === 'TxHoleA')).toBe(true);

          expect(eventsAtLoad.length).toBeLessThan(2);

          await expect(
            store.append(
              { type: 'FollowUp', data: { step: 'after-hole' } },
              { failIfEventsMatch: streamQuery, after: position },
            ),
          ).rejects.toThrow(/Append condition failed|ConcurrencyError/);
        } finally {
          await clientA.query('ROLLBACK').catch(() => undefined);
          await clientB.query('ROLLBACK').catch(() => undefined);
          clientA.release();
          clientB.release();
        }
      },
      60_000,
    );
  });
});
