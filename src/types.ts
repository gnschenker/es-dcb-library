import type { Query } from './query/types.js';

export interface NewEvent<D = Record<string, unknown>> {
  type: string;
  data: D;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/** Cursor for committed-only log followers (projections, stream-after). */
export interface StreamCursor {
  /** PostgreSQL xid8 of the inserting transaction (string from pg driver). */
  txId: string;
  globalPosition: bigint;
  /**
   * Snapshot `pg_snapshot_xmin` captured at `load()` time. Present on `load().position`;
   * used by append `after` to detect late commits below the watermark without re-matching
   * events that were already visible when the cursor was taken.
   */
  readXmin?: string;
}

/** Start cursor: before any event in (tx_id, global_position) order. */
export const STREAM_CURSOR_ORIGIN: StreamCursor = { txId: '0', globalPosition: 0n };

export interface StoredEvent<D = Record<string, unknown>> {
  globalPosition: bigint;
  eventId: string;
  type: string;
  data: D;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  tags: string[];
  /** Set when read from the database; required for committed-stream checkpoints. */
  txId: string;
}

export interface LoadResult {
  events: StoredEvent[];
  /**
   * Commit-order-safe stream head for this query (same visibility as `committedOnly` streams).
   * Pass to `append({ after: position })` after `load()`.
   */
  position: StreamCursor;
}

export interface AppendCondition {
  failIfEventsMatch: Query;
  /** Commit-order-safe cursor from `load().position` (or `STREAM_CURSOR_ORIGIN`). */
  after?: StreamCursor;
}

/** Cursor for a stored event (for tests and manual append conditions). */
export function eventStreamCursor(event: StoredEvent): StreamCursor {
  return { txId: event.txId, globalPosition: event.globalPosition };
}

export interface StreamOptions {
  batchSize?: number;
  /**
   * Keyset cursor for `committedOnly` streams (default: STREAM_CURSOR_ORIGIN).
   */
  afterCursor?: StreamCursor;
  /**
   * Legacy pagination by global_position only (non-committed visibility).
   */
  afterPosition?: bigint;
  /**
   * When true, only yields committed events (tx_id < snapshot xmin), ordered by
   * (tx_id, global_position). Safe for projections; not affected by sequence holes.
   */
  committedOnly?: boolean;
}

export type TagExtractor = (event: NewEvent) => string[];

/**
 * Symbol to mark event types that are intentionally untagged.
 */
export const UNTAGGED: unique symbol = Symbol('UNTAGGED');

export interface EventStore {
  load(query: Query): Promise<LoadResult>;
  /**
   * Atomic insert. `condition` is required to protect a DCB decision.
   * Omitting `condition` commits the batch without locking or version checks.
   */
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]>;
  stream(query: Query, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
