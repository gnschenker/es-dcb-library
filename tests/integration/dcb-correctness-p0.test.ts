/**
 * Adversarial correctness tests (Step 1: document bugs; no library fixes yet).
 *
 * Uses `it.fails` so CI stays green while assertions encode the *desired* behaviour.
 * When a fix lands, change `it.fails` → `it` (the test should then pass).
 *
 * Local run (Docker required): npm run test:integration -- tests/integration/dcb-correctness-p0.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryItem, ConcurrencyError } from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

const STREAM_TAG = 'dcb-p0:shared-stream';

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
    },
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('DCB correctness — P0 adversarial (expected failures)', () => {
  describe('P0 #1 — advisory locks derived only from failIfEventsMatch query', () => {
    it.fails(
      'at most one append succeeds when conditions share a stream but lock pairs differ by event type',
      async () => {
        const queryA = queryItem({ types: ['EventAlpha'], tags: [STREAM_TAG] });
        const queryB = queryItem({ types: ['EventBeta'], tags: [STREAM_TAG] });
        const streamQuery = queryItem({ tags: [STREAM_TAG] });

        let ready = 0;
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });

        const versions: { A: bigint; B: bigint } = { A: 0n, B: 0n };

        const runWriter = async (side: 'A' | 'B'): Promise<'success' | 'conflict' | 'error'> => {
          const q = side === 'A' ? queryA : queryB;
          const type = side === 'A' ? 'EventAlpha' : 'EventBeta';
          const { version } = await store.load(streamQuery);
          versions[side] = version;
          ready += 1;
          if (ready === 2) release();
          await barrier;

          try {
            await store.append(
              { type, data: { side } },
              { failIfEventsMatch: q, after: versions[side] },
            );
            return 'success';
          } catch (err) {
            if (err instanceof ConcurrencyError) return 'conflict';
            return 'error';
          }
        };

        const [outA, outB] = await Promise.all([runWriter('A'), runWriter('B')]);
        const successes = [outA, outB].filter((o) => o === 'success');
        const events = await store.load(streamQuery);

        expect(successes.length).toBeLessThanOrEqual(1);
        expect(events.events.length).toBeLessThanOrEqual(1);
      },
      60_000,
    );
  });

  describe('P0 #3 — load() version is max(global_position), not commit order', () => {
    it.fails(
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

          const { version } = await store.load(streamQuery);
          expect(version).toBeGreaterThan(0n);

          await clientA.query('COMMIT');

          const afterHole = await store.load(streamQuery);
          expect(afterHole.events.some((e) => e.type === 'TxHoleA')).toBe(true);

          await expect(
            store.append(
              { type: 'FollowUp', data: { step: 'after-hole' } },
              { failIfEventsMatch: streamQuery, after: version },
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
