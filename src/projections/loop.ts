import type pg from 'pg';
import type { StoredEvent, EventStore } from '../types.js';
import type { ProjectionDefinition } from './types.js';

/** Internal: sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Internal: resolved config with defaults applied */
export interface ResolvedConfig {
  maxRetries: number;
  retryDelayMs: number;
  streamBatchSize: number;
  pollIntervalMs: number;
  setupTimeoutMs: number;
  dryRun: boolean;
  onError: (name: string, err: unknown) => void;
  onRetry?: (name: string, attempt: number, err: unknown, nextDelayMs: number) => void;
  onStatusChange?: (name: string, oldStatus: ProjectionStatus, newStatus: ProjectionStatus) => void;
}

export type ProjectionStatus = 'pending' | 'catching-up' | 'live' | 'error' | 'stopped';

/** Internal mutable state for one projection loop */
export interface ProjectionLoopState {
  name: string;
  status: ProjectionStatus;
  lastPos: bigint;
  lastUpdatedAt: Date | null;
  errorDetail?: unknown;
  stopRequested: boolean;
  stopSignal: () => void;   // calling this resolves the waitForNotifyOrTimeout
  notifySignal: () => void; // called by shared LISTEN client when notification arrives
}

/**
 * Process one event atomically: handler + checkpoint in one transaction.
 * In dryRun mode: calls handler in a real transaction but rolls it back.
 */
export async function processEvent(
  def: ProjectionDefinition,
  event: StoredEvent,
  pool: pg.Pool,
  dryRun: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await def.handler(event, client);

    if (!dryRun) {
      await client.query(
        `UPDATE projection_checkpoints
         SET last_position = $1, updated_at = NOW()
         WHERE name = $2`,
        [event.globalPosition, def.name],
      );
      await client.query('COMMIT');
    } else {
      await client.query('ROLLBACK');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // swallow rollback errors
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Process one event with retry logic.
 * On handler-level errors: linear backoff, up to maxRetries.
 * After maxRetries: sets state to 'error', calls onError, throws.
 */
export async function processEventWithRetry(
  def: ProjectionDefinition,
  event: StoredEvent,
  pool: pg.Pool,
  state: ProjectionLoopState,
  config: ResolvedConfig,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await processEvent(def, event, pool, config.dryRun);
      return;
    } catch (err) {
      attempt++;
      const nextDelayMs = config.retryDelayMs * attempt;
      try {
        config.onRetry?.(def.name, attempt, err, nextDelayMs);
      } catch {
        // swallow
      }
      if (attempt > config.maxRetries) {
        const oldStatus = state.status;
        state.status = 'error';
        state.errorDetail = err;
        try {
          config.onStatusChange?.(def.name, oldStatus, 'error');
        } catch {
          // swallow
        }
        try {
          config.onError(def.name, err);
        } catch {
          // swallow — never propagate onError throws
        }
        throw err;
      }
      await sleep(nextDelayMs);
    }
  }
}

/**
 * Phase 1: Catch-up loop.
 * Streams all matching events from state.lastPos onward, processes each,
 * and updates state.lastPos. Stops if stopRequested is set.
 *
 * Uses keyset pagination via store.stream() — no long-lived transactions,
 * no server-side cursors. Safe to stop early.
 */
export async function runCatchUp(
  def: ProjectionDefinition,
  store: EventStore,
  pool: pg.Pool,
  state: ProjectionLoopState,
  config: ResolvedConfig,
): Promise<void> {
  const oldStatus = state.status;
  state.status = 'catching-up';
  try {
    config.onStatusChange?.(def.name, oldStatus, 'catching-up');
  } catch {
    // swallow
  }

  const eventStream = store.stream(def.query, {
    afterPosition: state.lastPos,
    batchSize: config.streamBatchSize,
  });

  for await (const event of eventStream) {
    if (state.stopRequested) break;
    await processEventWithRetry(def, event, pool, state, config);
    state.lastPos = event.globalPosition;
    state.lastUpdatedAt = new Date();
  }
}
