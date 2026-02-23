import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { query } from '../../src/index.js';
import { defineProjection } from '../../src/projections/types.js';
import { ProjectionManager } from '../../src/projections/manager.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { resetProjectionSchema } from './projections-helpers.js';

describe('projections — error handling and retry', () => {
  let pool: pg.Pool;
  let store: PostgresEventStore;
  let manager: ProjectionManager | null = null;

  beforeEach(async () => {
    if (!pool) pool = createTestPool();
    if (!store) store = new PostgresEventStore({ pool });
    await resetDatabase(pool);
    await resetProjectionSchema(pool);
    manager = null;
  });

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = null;
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function waitForStatus(
    mgr: ProjectionManager,
    projectionName: string,
    targetStatus: string,
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = mgr.getStatus().find((x) => x.name === projectionName);
      if (s?.status === targetStatus) return;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    throw new Error(`waitForStatus("${projectionName}", "${targetStatus}") timed out`);
  }

  it('retries on failure and succeeds on 3rd attempt, onRetry called each time', async () => {
    let handlerCallCount = 0;
    const retriedAttempts: number[] = [];

    await store.append({ type: 'RetryEvt', payload: {} });

    const proj = defineProjection({
      name: 'retry-test',
      query: query.eventsOfType('RetryEvt'),
      handler: async () => {
        handlerCallCount++;
        if (handlerCallCount < 3) throw new Error(`attempt ${handlerCallCount} failed`);
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      maxRetries: 3,
      retryDelayMs: 10,
      pollIntervalMs: 200,
      onRetry: (_name, attempt) => {
        retriedAttempts.push(attempt);
      },
      onError: () => {},
    });
    await manager.initialize();
    manager.start();

    // Wait for checkpoint to advance (means success)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const row = await pool.query<{ last_position: string | null }>(
        'SELECT last_position FROM projection_checkpoints WHERE name = $1',
        ['retry-test'],
      );
      if (row.rows[0]?.last_position != null) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(handlerCallCount).toBe(3);
    expect(retriedAttempts).toEqual([1, 2]);

    const status = manager.getStatus().find((s) => s.name === 'retry-test');
    expect(status?.status).toBe('live');
  });
  it('maxRetries exhausted => error state, onError called with projection name', async () => {
    await store.append({ type: 'ErrorEvt', payload: {} });

    let onErrorName = '';
    const proj = defineProjection({
      name: 'error-test',
      query: query.eventsOfType('ErrorEvt'),
      handler: async () => {
        throw new Error('always fails');
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      maxRetries: 1,
      retryDelayMs: 10,
      pollIntervalMs: 200,
      onError: (name) => {
        onErrorName = name;
      },
    });
    await manager.initialize();
    manager.start();

    await waitForStatus(manager, 'error-test', 'error');

    const status = manager.getStatus().find((s) => s.name === 'error-test');
    expect(status?.status).toBe('error');
    expect(status?.errorDetail).toBeInstanceOf(Error);
    expect(onErrorName).toBe('error-test');
  });

  it('onError that throws does not crash the projection manager', async () => {
    await store.append({ type: 'ThrowEvt', payload: {} });

    const proj = defineProjection({
      name: 'throwing-onerror',
      query: query.eventsOfType('ThrowEvt'),
      handler: async () => {
        throw new Error('handler fails');
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      maxRetries: 0,
      retryDelayMs: 10,
      pollIntervalMs: 200,
      onError: () => {
        throw new Error('onError also throws');
      },
    });
    await manager.initialize();
    manager.start();

    // If the manager survives to error state, it did not crash
    await waitForStatus(manager, 'throwing-onerror', 'error');
    expect(manager.getStatus().find((s) => s.name === 'throwing-onerror')?.status).toBe('error');
  });
  it('other projections continue processing when one enters error state', async () => {
    await store.append([
      { type: 'GoodEvt', payload: { id: 'g1' } },
      { type: 'BadEvt', payload: {} },
    ]);

    const processedGood: string[] = [];

    const goodProj = defineProjection({
      name: 'good-proj',
      query: query.eventsOfType('GoodEvt'),
      handler: async (event) => {
        processedGood.push(event.payload['id'] as string);
      },
    });

    const badProj = defineProjection({
      name: 'bad-proj',
      query: query.eventsOfType('BadEvt'),
      handler: async () => {
        throw new Error('bad handler');
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [goodProj, badProj],
      maxRetries: 0,
      retryDelayMs: 10,
      pollIntervalMs: 200,
      onError: () => {},
    });
    await manager.initialize();
    manager.start();

    // Wait for bad-proj error AND good-proj to be live
    await Promise.all([
      waitForStatus(manager, 'bad-proj', 'error'),
      waitForStatus(manager, 'good-proj', 'live'),
    ]);

    expect(manager.getStatus().find((s) => s.name === 'bad-proj')?.status).toBe('error');
    expect(manager.getStatus().find((s) => s.name === 'good-proj')?.status).toBe('live');
    expect(processedGood).toContain('g1');
  });
  it('restart() recovers error projection, re-reads checkpoint, returns to live', async () => {
    await store.append({ type: 'RestartEvt', payload: {} });

    let shouldFail = true;
    const proj = defineProjection({
      name: 'restart-test',
      query: query.eventsOfType('RestartEvt'),
      handler: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('first run fails');
        }
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      maxRetries: 0,
      retryDelayMs: 10,
      pollIntervalMs: 200,
      onError: () => {},
    });
    await manager.initialize();
    manager.start();

    await waitForStatus(manager, 'restart-test', 'error');
    expect(manager.getStatus().find((s) => s.name === 'restart-test')?.status).toBe('error');

    await manager.restart('restart-test');
    await waitForStatus(manager, 'restart-test', 'live');

    expect(manager.getStatus().find((s) => s.name === 'restart-test')?.status).toBe('live');

    // Verify checkpoint advanced
    const row = await pool.query<{ last_position: string | null }>(
      'SELECT last_position FROM projection_checkpoints WHERE name = $1',
      ['restart-test'],
    );
    expect(row.rows[0]?.last_position).not.toBeNull();
  });

});
