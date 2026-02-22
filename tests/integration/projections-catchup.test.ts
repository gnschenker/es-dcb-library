import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { query } from '../../src/index.js';
import { defineProjection } from '../../src/projections/types.js';
import {
  runCatchUp,
  type ResolvedConfig,
  type ProjectionLoopState,
  type ProjectionStatus,
} from '../../src/projections/loop.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { resetProjectionSchema } from './projections-helpers.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  if (!store) store = new PostgresEventStore({ pool });
  await resetDatabase(pool);
  await resetProjectionSchema(pool);
});

afterAll(async () => {
  await pool?.end();
});

function makeState(lastPos = 0n): ProjectionLoopState {
  return {
    name: 'test-projection',
    status: 'pending' as ProjectionStatus,
    lastPos,
    lastUpdatedAt: null,
    errorDetail: undefined,
    stopRequested: false,
    stopSignal: () => {},
    notifySignal: () => {},
  };
}

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    maxRetries: 0,
    retryDelayMs: 0,
    streamBatchSize: 100,
    pollIntervalMs: 5000,
    setupTimeoutMs: 5000,
    dryRun: false,
    onError: () => {},
    ...overrides,
  };
}

describe('runCatchUp()', () => {

  it('processes all pre-existing events from position 0', async () => {
    const [e1, e2, e3] = await store.append([
      { type: 'EvtA', payload: { id: '1' } },
      { type: 'EvtA', payload: { id: '2' } },
      { type: 'EvtA', payload: { id: '3' } },
    ]);

    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    const processed: string[] = [];
    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (event, _client) => {
        processed.push(event.payload['id'] as string);
      },
    });

    const state = makeState(0n);
    await runCatchUp(def, store, pool, state, makeConfig());

    expect(processed).toEqual(['1', '2', '3']);
    void e1;
    void e2;

    const row = await pool.query<{ last_position: string }>(
      `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
      ['test-projection'],
    );
    expect(BigInt(row.rows[0]!.last_position)).toBe(e3!.globalPosition);
  });

  it('skips events not matching the projection query', async () => {
    await store.append([
      { type: 'EvtA', payload: { id: 'a1' } },
      { type: 'EvtB', payload: { id: 'b1' } },
      { type: 'EvtA', payload: { id: 'a2' } },
    ]);

    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    const processed: string[] = [];
    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (event, _client) => {
        processed.push(event.payload['id'] as string);
      },
    });

    await runCatchUp(def, store, pool, makeState(0n), makeConfig());
    expect(processed).toEqual(['a1', 'a2']);
    expect(processed).not.toContain('b1');
  });

  it('checkpoint equals last processed globalPosition', async () => {
    const events = await store.append([
      { type: 'EvtA', payload: {} },
      { type: 'EvtA', payload: {} },
      { type: 'EvtA', payload: {} },
      { type: 'EvtA', payload: {} },
      { type: 'EvtA', payload: {} },
    ]);
    const lastEvent = events[events.length - 1]!;

    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async () => {},
    });

    await runCatchUp(def, store, pool, makeState(0n), makeConfig());

    const row = await pool.query<{ last_position: string }>(
      `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
      ['test-projection'],
    );
    expect(BigInt(row.rows[0]!.last_position)).toBe(lastEvent.globalPosition);
  });

  it('does not reprocess events already past the checkpoint on restart', async () => {
    await store.append([
      { type: 'EvtA', payload: { id: '1' } },
      { type: 'EvtA', payload: { id: '2' } },
      { type: 'EvtA', payload: { id: '3' } },
    ]);

    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    const firstRunProcessed: string[] = [];
    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (event, _client) => {
        firstRunProcessed.push(event.payload['id'] as string);
      },
    });

    const state = makeState(0n);
    await runCatchUp(def, store, pool, state, makeConfig());
    expect(firstRunProcessed).toHaveLength(3);

    await store.append([
      { type: 'EvtA', payload: { id: '4' } },
      { type: 'EvtA', payload: { id: '5' } },
    ]);

    const secondRunProcessed: string[] = [];
    const def2 = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (event, _client) => {
        secondRunProcessed.push(event.payload['id'] as string);
      },
    });
    const state2 = makeState(state.lastPos);
    await runCatchUp(def2, store, pool, state2, makeConfig());

    expect(secondRunProcessed).toEqual(['4', '5']);
  });

  it('atomicity: handler error rolls back both read-model write and checkpoint', async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS test_read_model (id TEXT PRIMARY KEY)`,
    );

    const [event] = await store.append({ type: 'EvtA', payload: { id: 'test-1' } });
    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    void event;

    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (_event, client) => {
        await client.query(`INSERT INTO test_read_model (id) VALUES ('row-1')`);
        throw new Error('handler failed intentionally');
      },
    });

    await expect(
      runCatchUp(def, store, pool, makeState(0n), makeConfig({ maxRetries: 0 })),
    ).rejects.toThrow('handler failed intentionally');

    const rmRow = await pool.query(`SELECT * FROM test_read_model`);
    expect(rmRow.rows).toHaveLength(0);

    const cpRow = await pool.query<{ last_position: string | null }>(
      `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
      ['test-projection'],
    );
    expect(cpRow.rows[0]?.last_position).toBeNull();

    await pool.query(`DROP TABLE IF EXISTS test_read_model`);
  });

  it('dryRun: handler is called but read-model write is rolled back, checkpoint not advanced', async () => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS test_dry_run_model (id TEXT PRIMARY KEY)`,
    );

    await store.append({ type: 'EvtA', payload: { id: 'dry-1' } });
    await pool.query(
      `INSERT INTO projection_checkpoints (name, last_position) VALUES ($1, NULL)`,
      ['test-projection'],
    );

    let handlerCallCount = 0;
    const def = defineProjection({
      name: 'test-projection',
      query: query.eventsOfType('EvtA'),
      handler: async (_event, client) => {
        handlerCallCount++;
        await client.query(`INSERT INTO test_dry_run_model (id) VALUES ('dry-row')`);
      },
    });

    await runCatchUp(def, store, pool, makeState(0n), makeConfig({ dryRun: true }));

    expect(handlerCallCount).toBe(1);

    const rmRow = await pool.query(`SELECT * FROM test_dry_run_model`);
    expect(rmRow.rows).toHaveLength(0);

    const cpRow = await pool.query<{ last_position: string | null }>(
      `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
      ['test-projection'],
    );
    expect(cpRow.rows[0]?.last_position).toBeNull();

    await pool.query(`DROP TABLE IF EXISTS test_dry_run_model`);
  });
});

