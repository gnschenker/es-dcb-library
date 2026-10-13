/**
 * Adversarial P0 DCB correctness (locks + commit-order-safe load/append positions).
 *
 * Local run (Docker required): npm run test:integration -- tests/integration/dcb-correctness-p0.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryItem, ConcurrencyError, type StreamCursor, type Query } from '../../src/index.js';
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

async function runDualWriterRace(
  failIfForSide: (side: 'A' | 'B') => Query,
  typeForSide: (side: 'A' | 'B') => string,
  streamQuery: Query,
): Promise<{ outA: string; outB: string; eventCount: number }> {
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
    const { position } = await store.load(streamQuery);
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
  const events = await store.load(streamQuery);
  return { outA, outB, eventCount: events.events.length };
}

describe('DCB correctness — P0 adversarial', () => {
  describe('P0 #1 — advisory locks on condition ∪ appended events', () => {
    const queryA = () => queryItem({ types: ['EventAlpha'], tags: [STREAM_TAG] });
    const queryB = () => queryItem({ types: ['EventBeta'], tags: [STREAM_TAG] });
    const streamQuery = () => queryItem({ tags: [STREAM_TAG] });

    it(
      'at most one append succeeds when conditions share a tag but differ by event type',
      async () => {
        const { outA, outB, eventCount } = await runDualWriterRace(
          (side) => (side === 'A' ? queryA() : queryB()),
          (side) => (side === 'A' ? 'EventAlpha' : 'EventBeta'),
          streamQuery(),
        );

        const successes = [outA, outB].filter((o) => o === 'success');
        expect(successes.length).toBeLessThanOrEqual(1);
        expect(eventCount).toBeLessThanOrEqual(1);
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
