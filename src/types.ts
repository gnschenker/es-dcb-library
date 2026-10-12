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
  version: bigint;
}

export interface AppendCondition {
  failIfEventsMatch: Query;
  after?: bigint;
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
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]>;
  stream(query: Query, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
