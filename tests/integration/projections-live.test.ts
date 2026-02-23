import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/store/event-store.js';
import { query } from '../../src/index.js';
import { defineProjection } from '../../src/projections/types.js';
import { ProjectionManager } from '../../src/projections/manager.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { resetProjectionSchema } from './projections-helpers.js';

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

describe('ProjectionManager — live phase', () => {
  it('processes event appended after catch-up completes', async () => {
    const processed: string[] = [];
    const proj = defineProjection({
      name: 'live-test',
      query: query.eventsOfType('LiveEvt'),
      handler: async (event, _client) => {
        processed.push(event.payload['id'] as string);
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 200,
    });
    await manager.initialize();
    manager.start();
    await manager.waitUntilLive(5000);

    // Append event AFTER manager is live
    const [appended] = await store.append({ type: 'LiveEvt', payload: { id: 'live-1' } });

    // Wait for projection to process it
    await manager.waitForPosition('live-test', appended!.globalPosition, 3000);

    expect(processed).toContain('live-1');
  });

  it('processes all events from a multi-event batch', async () => {
    const processed: bigint[] = [];
    const proj = defineProjection({
      name: 'batch-test',
      query: query.eventsOfType('BatchEvt'),
      handler: async (event, _client) => {
        processed.push(event.globalPosition);
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 200,
    });
    await manager.initialize();
    manager.start();
    await manager.waitUntilLive(5000);

    // Append 5 events in one call
    const appended = await store.append([
      { type: 'BatchEvt', payload: {} },
      { type: 'BatchEvt', payload: {} },
      { type: 'BatchEvt', payload: {} },
      { type: 'BatchEvt', payload: {} },
      { type: 'BatchEvt', payload: {} },
    ]);
    const lastPos = appended[appended.length - 1]!.globalPosition;

    await manager.waitForPosition('batch-test', lastPos, 3000);
    expect(processed).toHaveLength(5);
  });

  it('gap-free: events appended during catch-up are not missed', async () => {
    // Append some events before manager starts (will be processed in catch-up)
    await store.append([
      { type: 'GapEvt', payload: { id: 'pre-1' } },
      { type: 'GapEvt', payload: { id: 'pre-2' } },
    ]);

    const processed: string[] = [];
    const proj = defineProjection({
      name: 'gap-test',
      query: query.eventsOfType('GapEvt'),
      handler: async (event, _client) => {
        processed.push(event.payload['id'] as string);
      },
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 200,
    });
    await manager.initialize();
    manager.start();

    // Append another event — may arrive during catch-up or immediately after
    const [liveEvent] = await store.append({ type: 'GapEvt', payload: { id: 'live-1' } });

    await manager.waitForPosition('gap-test', liveEvent!.globalPosition, 5000);

    expect(processed).toContain('pre-1');
    expect(processed).toContain('pre-2');
    expect(processed).toContain('live-1');
  });

  it('stop() completes within 2 seconds and status becomes stopped', async () => {
    const proj = defineProjection({
      name: 'stop-test',
      query: query.eventsOfType('StopEvt'),
      handler: async () => {},
    });

    const mgr = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 500,
    });
    await mgr.initialize();
    mgr.start();
    await mgr.waitUntilLive(5000);

    const start = Date.now();
    await mgr.stop();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);

    // After stop, getStatus() should show stopped
    const statuses = mgr.getStatus().map((s) => s.status);
    expect(statuses).toEqual(['stopped']);
    // Do not assign to manager — we already stopped it manually
  });

  it('waitUntilLive() resolves when all projections reach live status', async () => {
    const proj1 = defineProjection({
      name: 'live-proj-1',
      query: query.eventsOfType('LiveEvtA'),
      handler: async () => {},
    });
    const proj2 = defineProjection({
      name: 'live-proj-2',
      query: query.eventsOfType('LiveEvtB'),
      handler: async () => {},
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj1, proj2],
      pollIntervalMs: 200,
    });
    await manager.initialize();
    manager.start();

    // Should resolve within 5 seconds
    await expect(manager.waitUntilLive(5000)).resolves.toBeUndefined();

    const statuses = manager.getStatus().map((s) => s.status);
    expect(statuses.every((s) => s === 'live')).toBe(true);
  });

  it('waitForPosition() resolves when checkpoint reaches target position', async () => {
    const proj = defineProjection({
      name: 'pos-test',
      query: query.eventsOfType('PosEvt'),
      handler: async () => {},
    });

    manager = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 200,
    });
    await manager.initialize();
    manager.start();
    await manager.waitUntilLive(5000);

    const [event] = await store.append({ type: 'PosEvt', payload: {} });

    // Should resolve within 3 seconds once checkpoint reaches event.globalPosition
    await expect(
      manager.waitForPosition('pos-test', event!.globalPosition, 3000),
    ).resolves.toBeUndefined();
  });

  it('waitUntilLive() rejects when timeout elapses', async () => {
    // Use a handler that sleeps briefly — long enough that waitUntilLive(50ms)
    // times out before catch-up finishes, short enough that stop() completes
    // well within the test's own 15-second timeout.
    const proj = defineProjection({
      name: 'timeout-test',
      query: query.eventsOfType('TimeoutEvt'),
      handler: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      },
    });

    // Append an event so catch-up has work to do (and the handler runs)
    await store.append({ type: 'TimeoutEvt', payload: {} });

    const mgr = new ProjectionManager({
      pool,
      store,
      projections: [proj],
      pollIntervalMs: 10_000,
    });
    await mgr.initialize();
    mgr.start();

    // 50ms timeout elapses while catch-up is still running the 2-second handler
    await expect(mgr.waitUntilLive(50)).rejects.toThrow(/timed out/);

    // stop() waits for the handler to finish — completes within ~2 seconds
    await mgr.stop();
  }, 15_000);
});
