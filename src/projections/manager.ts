import pg from 'pg';
import type { EventStore, StreamCursor } from '../types.js';
import { STREAM_CURSOR_ORIGIN } from '../types.js';
import type { ProjectionDefinition } from './types.js';
import {
  sleep,
  ResolvedConfig,
  ProjectionStatus,
  ProjectionLoopState,
  WaitSignalResult,
  createWaitForSignal,
  runProjectionLoop,
  ManagedListenClient,
} from './loop.js';
import { applyProjectionSchema } from './schema.js';
import { runProjectionSetup } from './setup.js';
import { evaluateProjectionReadiness, cursorReached } from './readiness.js';
import { ProjectionNotReadyError } from '../errors.js';

export interface ProjectionManagerConfig {
  /** Connection pool for read-model writes and checkpoint updates. */
  pool: pg.Pool;
  store: EventStore;
  projections: ProjectionDefinition[];
  onError?: (projectionName: string, error: unknown) => void;
  onRetry?: (projectionName: string, attempt: number, error: unknown, nextDelayMs: number) => void;
  onStatusChange?: (
    projectionName: string,
    oldStatus: ProjectionStatus,
    newStatus: ProjectionStatus,
  ) => void;
  maxRetries?: number;
  retryDelayMs?: number;
  streamBatchSize?: number;
  pollIntervalMs?: number;
  setupTimeoutMs?: number;
  singleInstance?: boolean;
  dryRun?: boolean;
}

export type { ProjectionStatus } from './loop.js';   // re-export for consumers

export interface ProjectionState {
  name: string;
  status: ProjectionStatus;
  lastProcessedCursor: StreamCursor;
  /** Last processed global_position (convenience for callers that only track position). */
  lastProcessedPosition: bigint;
  lastUpdatedAt: Date | null;
  errorDetail?: unknown;
}

function checkpointRowToCursor(row: {
  last_tx_id: string | null;
  last_position: string | null;
}): StreamCursor {
  if (row.last_tx_id == null || row.last_position == null) {
    return STREAM_CURSOR_ORIGIN;
  }
  return {
    txId: row.last_tx_id,
    globalPosition: BigInt(row.last_position),
  };
}

export class ProjectionManager {
  private readonly resolved: ResolvedConfig;
  private listenClient: ManagedListenClient | null = null;
  private readonly loopStates: Map<string, ProjectionLoopState> = new Map();
  private readonly loopPromises: Promise<void>[] = [];
  private readonly lockClients: Map<string, pg.Client> = new Map();
  private started = false;

  constructor(private readonly config: ProjectionManagerConfig) {
    this.resolved = {
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 500,
      streamBatchSize: config.streamBatchSize ?? 200,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      setupTimeoutMs: config.setupTimeoutMs ?? 30_000,
      dryRun: config.dryRun ?? false,
      onError: config.onError ?? ((name, err) => {
        console.error(`[projections] "${name}" failed:`, err);
      }),
      ...(config.onRetry !== undefined ? { onRetry: config.onRetry } : {}),
      ...(config.onStatusChange !== undefined ? { onStatusChange: config.onStatusChange } : {}),
    };
  }

  async initialize(): Promise<void> {
    // 1. Apply projection schema DDL (idempotent)
    const schemaClient = await this.config.pool.connect();
    try {
      await applyProjectionSchema(schemaClient);
    } finally {
      schemaClient.release();
    }

    for (const def of this.config.projections) {
      await runProjectionSetup(def, this.config.pool, this.resolved.setupTimeoutMs);
    }

    // 3. Insert initial checkpoint rows (idempotent)
    const cpClient = await this.config.pool.connect();
    try {
      for (const def of this.config.projections) {
        await cpClient.query(
          'INSERT INTO projection_checkpoints (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [def.name],
        );
      }
    } finally {
      cpClient.release();
    }

    // 4. Start shared LISTEN client BEFORE loops (gap-free guarantee)
    this.listenClient = new ManagedListenClient(this.getConnectionString());
    await this.listenClient.start();
  }

  start(): void {
    if (this.started) throw new Error('ProjectionManager.start() has already been called');
    this.started = true;

    for (const def of this.config.projections) {
      const { waitForSignal, triggerNotify, triggerStop } = createWaitForSignal(
        this.resolved.pollIntervalMs,
      );
      this.listenClient!.addNotifyCallback(triggerNotify);

      const loopPromise = this.runLoop(def, triggerNotify, triggerStop, waitForSignal);
      this.loopPromises.push(loopPromise.catch(() => {}));
    }
  }

  async stop(): Promise<void> {
    for (const state of this.loopStates.values()) {
      state.stopRequested = true;
      try { state.stopSignal(); } catch { /* swallow */ }
    }
    await Promise.allSettled(this.loopPromises);
    if (this.listenClient) {
      await this.listenClient.stop();
      this.listenClient = null;
    }
    // Release singleInstance lock clients
    for (const client of this.lockClients.values()) {
      try { await client.end(); } catch { /* swallow */ }
    }
    this.lockClients.clear();
  }

  /**
   * Resolves only when every configured projection is `live`.
   * Throws `ProjectionNotReadyError` if any loop is `error` or `stopped`
   * (including single-instance lock not acquired).
   */
  async waitUntilLive(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expected = this.config.projections.length;
    while (Date.now() < deadline) {
      const readiness = evaluateProjectionReadiness(
        [...this.loopStates.values()].map((s) => ({ name: s.name, status: s.status })),
        expected,
      );
      if (readiness.kind === 'live') {
        return;
      }
      if (readiness.kind === 'failed') {
        throw new ProjectionNotReadyError(
          `waitUntilLive failed: ${readiness.failed.map((f) => `${f.name}=${f.status}`).join(', ')}`,
          readiness.failed,
        );
      }
      await sleep(50);
    }
    throw new ProjectionNotReadyError(`waitUntilLive timed out after ${timeoutMs}ms`);
  }

  /**
   * Convenience wait on checkpoint `last_position` only.
   * This is **not** a commit-order watermark — a higher position can appear
   * before an older transaction commits. Use `waitForCursor` for (tx_id, position).
   */
  async waitForPosition(
    projectionName: string,
    targetPosition: bigint,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.config.pool.query<{ last_position: string | null }>(
        'SELECT last_position FROM projection_checkpoints WHERE name = $1',
        [projectionName],
      );
      const pos = result.rows[0]?.last_position != null
        ? BigInt(result.rows[0].last_position)
        : 0n;
      if (pos >= targetPosition) return;
      await sleep(50);
    }
    throw new Error(
      `waitForPosition("${projectionName}", ${targetPosition}) timed out after ${timeoutMs}ms`,
    );
  }

  /**
   * Waits until the projection checkpoint is at or past `target` in
   * `(tx_id, global_position)` order (same cursor as committed-only streams).
   */
  async waitForCursor(
    projectionName: string,
    target: StreamCursor,
    timeoutMs = 5_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.config.pool.query<{
        last_tx_id: string | null;
        last_position: string | null;
      }>(
        'SELECT last_tx_id, last_position FROM projection_checkpoints WHERE name = $1',
        [projectionName],
      );
      const row = result.rows[0];
      const current = checkpointRowToCursor(
        row ?? { last_tx_id: null, last_position: null },
      );
      if (cursorReached(current, target)) {
        return;
      }
      await sleep(50);
    }
    throw new Error(
      `waitForCursor("${projectionName}", ${target.txId}:${target.globalPosition}) timed out after ${timeoutMs}ms`,
    );
  }

  async restart(projectionName: string): Promise<void> {
    const state = this.loopStates.get(projectionName);
    if (!state || state.status !== 'error') return;

    const def = this.config.projections.find((d) => d.name === projectionName);
    if (!def) return;

    const result = await this.config.pool.query<{
      last_tx_id: string | null;
      last_position: string | null;
    }>(
      'SELECT last_tx_id, last_position FROM projection_checkpoints WHERE name = $1',
      [projectionName],
    );
    const lastCursor = checkpointRowToCursor(
      result.rows[0] ?? { last_tx_id: null, last_position: null },
    );

    state.lastCursor = lastCursor;
    state.errorDetail = undefined;
    state.status = 'pending';
    state.stopRequested = false;

    const { waitForSignal, triggerNotify, triggerStop } = createWaitForSignal(
      this.resolved.pollIntervalMs,
    );
    state.stopSignal = triggerStop;
    state.notifySignal = triggerNotify;

    this.listenClient?.addNotifyCallback(triggerNotify);
    const loopPromise = this.runLoop(def, triggerNotify, triggerStop, waitForSignal);
    this.loopPromises.push(loopPromise.catch(() => {}));
  }

  getStatus(): ProjectionState[] {
    return [...this.loopStates.values()].map((state) => ({
      name: state.name,
      status: state.status,
      lastProcessedCursor: state.lastCursor,
      lastProcessedPosition: state.lastCursor.globalPosition,
      lastUpdatedAt: state.lastUpdatedAt,
      errorDetail: state.errorDetail,
    }));
  }

  private async runLoop(
    def: ProjectionDefinition,
    triggerNotify: () => void,
    triggerStop: () => void,
    waitForSignal: () => Promise<WaitSignalResult>,
  ): Promise<void> {
    // singleInstance: try to acquire advisory lock
    if (this.config.singleInstance) {
      const lockClient = new pg.Client({ connectionString: this.getConnectionString() });
      await lockClient.connect();
      const lockResult = await lockClient.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [def.name],
      );
      if (!lockResult.rows[0]?.acquired) {
        await lockClient.end();
        this.loopStates.set(def.name, {
          name: def.name,
          status: 'stopped',
          lastCursor: STREAM_CURSOR_ORIGIN,
          lastUpdatedAt: null,
          errorDetail: { reason: 'singleInstanceLockNotAcquired' },
          stopRequested: true,
          stopSignal: triggerStop,
          notifySignal: triggerNotify,
        });
        return;
      }
      this.lockClients.set(def.name, lockClient);
    }

    // Read initial checkpoint
    const result = await this.config.pool.query<{
      last_tx_id: string | null;
      last_position: string | null;
      updated_at: Date | null;
    }>(
      'SELECT last_tx_id, last_position, updated_at FROM projection_checkpoints WHERE name = $1',
      [def.name],
    );
    const row = result.rows[0];
    const lastCursor = checkpointRowToCursor(
      row ?? { last_tx_id: null, last_position: null },
    );

    const state: ProjectionLoopState = {
      name: def.name,
      status: 'pending',
      lastCursor,
      lastUpdatedAt: row?.updated_at ?? null,
      stopRequested: false,
      stopSignal: triggerStop,
      notifySignal: triggerNotify,
    };
    this.loopStates.set(def.name, state);

    try {
      await runProjectionLoop(
        def,
        this.config.store,
        this.config.pool,
        state,
        this.resolved,
        waitForSignal,
      );
    } catch {
      // error state already set by processEventWithRetry
    } finally {
      if (state.status !== 'error') {
        const oldStatus = state.status;
        state.status = 'stopped';
        try {
          this.resolved.onStatusChange?.(def.name, oldStatus, 'stopped');
        } catch { /* swallow */ }
      }
      this.listenClient?.removeNotifyCallback(triggerNotify);
    }
  }

  private getConnectionString(): string {
    // pg.Pool stores connection options internally
    const opts = (this.config.pool as unknown as { options: Record<string, unknown> }).options;
    if (typeof opts['connectionString'] === 'string') return opts['connectionString'] as string;
    const host = (opts['host'] as string | undefined) ?? 'localhost';
    const port = (opts['port'] as number | undefined) ?? 5432;
    const database = (opts['database'] as string | undefined) ?? 'postgres';
    const user = (opts['user'] as string | undefined) ?? '';
    const password = (opts['password'] as string | undefined) ?? '';
    if (user && password) return `postgres://${user}:${password}@${host}:${port}/${database}`;
    if (user) return `postgres://${user}@${host}:${port}/${database}`;
    return `postgres://${host}:${port}/${database}`;
  }
}
