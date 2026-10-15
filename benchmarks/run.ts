/**
 * Operational benchmarks for P2 #8.
 *
 *   npm run bench
 *
 * Requires Docker (testcontainers, same as integration tests). Writes a
 * machine-readable summary to stdout; the committed numbers live in
 * `.docs/benchmarks.md`.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryAll, queryItem, applySchema } from '../src/index.js';
import {
  compileLoadCommittedQuery,
  compileExistsQuery,
  compileCommittedStreamQuery,
} from '../src/query/compiler.js';
import { STREAM_CURSOR_ORIGIN } from '../src/types.js';

interface Percentiles {
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  opsPerSec: number;
}

let pool: pg.Pool;
let store: PostgresEventStore;

function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarize(samplesMs: number[], elapsedMs: number, operations: number): Percentiles {
  const meanMs = samplesMs.length === 0
    ? elapsedMs / Math.max(1, operations)
    : samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
  return {
    n: operations,
    p50Ms: round(pct(samplesMs, 50)),
    p95Ms: round(pct(samplesMs, 95)),
    p99Ms: round(pct(samplesMs, 99)),
    meanMs: round(meanMs),
    opsPerSec: round(operations / (elapsedMs / 1000)),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function reset(): Promise<void> {
  const client = await pool.connect();
  try {
    await applySchema(client);
    await client.query('TRUNCATE events RESTART IDENTITY CASCADE');
    await client.query('ANALYZE events');
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) throw new Error('TEST_DATABASE_URL is not set');
  pool = new pg.Pool({ connectionString, max: 12 });
  store = new PostgresEventStore({ pool });
  await reset();
});

afterAll(async () => {
  await pool?.end();
});

describe('P2 operational benchmarks', () => {
  it('measures append / load / stream throughput and records query plans', async () => {
    const results: {
      postgres: string;
      node: string;
      capturedAt: string;
      unconditionalAppend?: Percentiles;
      conditionalAppend?: Percentiles;
      highContention?: Percentiles & { successes: number; conflicts: number };
      loadAll?: { events: number; ms: number; eventsPerSec: number };
      committedStream?: { events: number; ms: number; eventsPerSec: number };
      plans?: { loadCommitted: string; existsAfter: string; committedStream: string };
    } = {
      postgres: (await pool.query<{ v: string }>('SELECT version() AS v')).rows[0]!.v,
      node: process.version,
      capturedAt: new Date().toISOString(),
    };

    // --- unconditional sequential append ---
    await reset();
    const uncondN = 400;
    const uncondSamples: number[] = [];
    const uncondStart = performance.now();
    for (let i = 0; i < uncondN; i += 1) {
      const t0 = performance.now();
      await store.append({ type: 'Bench', data: { i }, tags: ['bench'] });
      uncondSamples.push(performance.now() - t0);
    }
    results.unconditionalAppend = summarize(uncondSamples, performance.now() - uncondStart, uncondN);

    // --- conditional sequential append on one stream ---
    await reset();
    const condN = 200;
    const condSamples: number[] = [];
    const condQ = queryItem({ tags: ['bench'] });
    const condStart = performance.now();
    for (let i = 0; i < condN; i += 1) {
      const { position } = await store.load(condQ);
      const t0 = performance.now();
      await store.append(
        { type: 'BenchCond', data: { i }, tags: ['bench'] },
        { failIfEventsMatch: condQ, after: position },
      );
      condSamples.push(performance.now() - t0);
    }
    results.conditionalAppend = summarize(condSamples, performance.now() - condStart, condN);

    // --- concurrent contended appends (8 writers × 5 rounds) ---
    await reset();
    const writers = 8;
    const rounds = 5;
    const contendedSamples: number[] = [];
    const contendedStart = performance.now();
    let successes = 0;
    let conflicts = 0;
    for (let r = 0; r < rounds; r += 1) {
      const q = queryItem({ tags: ['bench'] });
      const { position } = await store.load(q);
      const started = await Promise.all(
        Array.from({ length: writers }, async (_, i) => {
          const t0 = performance.now();
          try {
            await store.append(
              { type: 'BenchRace', data: { r, i }, tags: ['bench'] },
              { failIfEventsMatch: q, after: position },
            );
            contendedSamples.push(performance.now() - t0);
            return 'success' as const;
          } catch {
            contendedSamples.push(performance.now() - t0);
            return 'conflict' as const;
          }
        }),
      );
      successes += started.filter((s) => s === 'success').length;
      conflicts += started.filter((s) => s === 'conflict').length;
    }
    results.highContention = {
      ...summarize(contendedSamples, performance.now() - contendedStart, writers * rounds),
      successes,
      conflicts,
    };

    // --- load / stream of a larger history ---
    await reset();
    const history = 2_000;
    const chunk = 100;
    for (let i = 0; i < history; i += chunk) {
      await store.append(
        Array.from({ length: chunk }, (_, j) => ({
          type: 'Hist',
          data: { n: i + j },
          tags: ['bench', (i + j) % 2 === 0 ? 'even' : 'odd'],
        })),
      );
    }

    const loadStart = performance.now();
    const loaded = await store.load(queryAll());
    const loadMs = performance.now() - loadStart;
    expect(loaded.events).toHaveLength(history);
    results.loadAll = { events: history, ms: round(loadMs), eventsPerSec: round(history / (loadMs / 1000)) };

    const streamStart = performance.now();
    let streamed = 0;
    for await (const _event of store.stream(queryAll(), { committedOnly: true, batchSize: 200 })) {
      streamed += 1;
    }
    const streamMs = performance.now() - streamStart;
    expect(streamed).toBe(history);
    results.committedStream = {
      events: streamed,
      ms: round(streamMs),
      eventsPerSec: round(streamed / (streamMs / 1000)),
    };

    // --- query plans ---
    const loadQ = compileLoadCommittedQuery(queryItem({ types: ['Hist'], tags: ['bench'] }));
    const existsQ = compileExistsQuery(queryItem({ tags: ['bench'] }), {
      txId: '1',
      globalPosition: 1n,
      readXmin: '1',
    });
    const streamQ = compileCommittedStreamQuery(queryAll(), STREAM_CURSOR_ORIGIN, 200);

    const explain = async (sql: string, params: unknown[]): Promise<string> => {
      const client = await pool.connect();
      try {
        const res = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN ${sql}`,
          params as unknown[],
        );
        return res.rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        client.release();
      }
    };

    results.plans = {
      loadCommitted: await explain(loadQ.sql, loadQ.params),
      existsAfter: await explain(existsQ.sql, existsQ.params),
      committedStream: await explain(streamQ.sql, streamQ.params),
    };

    // eslint-disable-next-line no-console
    console.log('\n=== P2 benchmark summary ===\n' + JSON.stringify(results, null, 2));

    expect(loaded.events.length).toBe(history);
  }, 180_000);
});
