import pg from 'pg';
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

/**
 * Waits for either a notify signal or the poll timeout to elapse.
 * The signal can be triggered by: NOTIFY from PostgreSQL, poll timeout, or stop request.
 * Returns 'notified' | 'timeout' | 'stopped'.
 */
export type WaitSignalResult = 'notified' | 'timeout' | 'stopped';

export function createWaitForSignal(
  pollIntervalMs: number,
): {
  waitForSignal: () => Promise<WaitSignalResult>;
  triggerNotify: () => void;
  triggerStop: () => void;
} {
  let resolveWait: ((result: WaitSignalResult) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cleanup() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    resolveWait = null;
  }

  function triggerNotify() {
    if (resolveWait) {
      const r = resolveWait;
      cleanup();
      r('notified');
    }
  }

  function triggerStop() {
    if (resolveWait) {
      const r = resolveWait;
      cleanup();
      r('stopped');
    }
  }

  function waitForSignal(): Promise<WaitSignalResult> {
    return new Promise<WaitSignalResult>((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        cleanup();
        resolve('timeout');
      }, pollIntervalMs);
    });
  }

  return { waitForSignal, triggerNotify, triggerStop };
}

/**
 * Drain all new events since state.lastPos.
 * Used by both the unconditional post-catch-up drain and the live loop.
 */
async function drainNewEvents(
  def: ProjectionDefinition,
  store: EventStore,
  pool: pg.Pool,
  state: ProjectionLoopState,
  config: ResolvedConfig,
): Promise<void> {
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

/**
 * Phase 2: Live loop.
 * Listens for signals (NOTIFY or poll timeout), then drains new events.
 * The caller provides `waitForSignal` from createWaitForSignal() — the manager
 * wires the shared LISTEN client to call `triggerNotify` for all loops.
 *
 * Gap-free transition guarantee:
 *  - The shared LISTEN client starts LISTEN before any loop is spawned
 *  - runCatchUp completes, then runLive does one unconditional drain before
 *    entering the wait loop — this closes the gap between catch-up and live.
 */
export async function runLive(
  def: ProjectionDefinition,
  store: EventStore,
  pool: pg.Pool,
  state: ProjectionLoopState,
  config: ResolvedConfig,
  waitForSignal: () => Promise<WaitSignalResult>,
): Promise<void> {
  const oldStatus = state.status;
  state.status = 'live';
  try {
    config.onStatusChange?.(def.name, oldStatus, 'live');
  } catch {
    // swallow
  }

  // Unconditional drain — closes the gap between catch-up end and first NOTIFY
  await drainNewEvents(def, store, pool, state, config);

  // Main live loop
  while (!state.stopRequested) {
    const result = await waitForSignal();
    if (result === 'stopped' || state.stopRequested) break;
    await drainNewEvents(def, store, pool, state, config);
  }
}

/**
 * Top-level projection loop: catch-up then live.
 * Called by ProjectionManager.start() for each projection.
 */
export async function runProjectionLoop(
  def: ProjectionDefinition,
  store: EventStore,
  pool: pg.Pool,
  state: ProjectionLoopState,
  config: ResolvedConfig,
  waitForSignal: () => Promise<WaitSignalResult>,
): Promise<void> {
  await runCatchUp(def, store, pool, state, config);
  if (!state.stopRequested) {
    await runLive(def, store, pool, state, config, waitForSignal);
  }
}

/**
 * Manages a dedicated pg.Client for LISTEN with automatic reconnection.
 * Sends a single triggerNotify() to all registered loops when a NOTIFY arrives.
 * Uses exponential backoff for reconnection: starts at 1s, caps at 60s.
 */
export class ManagedListenClient {
  private client: pg.Client | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 60_000;
  private stopped = false;
  private readonly notifyCallbacks: Set<() => void> = new Set();

  constructor(private readonly connectionString: string) {}

  /** Register a callback to be called on every NOTIFY received. */
  addNotifyCallback(cb: () => void): void {
    this.notifyCallbacks.add(cb);
  }

  removeNotifyCallback(cb: () => void): void {
    this.notifyCallbacks.delete(cb);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client) {
      try {
        await this.client.query('UNLISTEN es_events');
        await this.client.end();
      } catch {
        // swallow
      }
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString });

    client.on('error', (err) => {
      console.error('[projections] LISTEN client error:', err);
      this.scheduleReconnect();
    });

    client.on('end', () => {
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    client.on('notification', () => {
      this.reconnectDelay = 1000; // reset on successful notification
      this.notifyCallbacks.forEach((cb) => {
        try { cb(); } catch { /* swallow */ }
      });
    });

    try {
      await client.connect();
      await client.query('LISTEN es_events');
      this.client = client;
      this.reconnectDelay = 1000;
    } catch (err) {
      console.error('[projections] LISTEN client connect failed:', err);
      try { await client.end(); } catch { /* swallow */ }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Wake all loops to drain via polling while reconnecting
    this.notifyCallbacks.forEach((cb) => {
      try { cb(); } catch { /* swallow */ }
    });
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    setTimeout(() => void this.connect(), delay);
  }
}
