import type { Query } from './query/types.js';

export interface NewEvent<D = Record<string, unknown>> {
  type: string;
  data: D;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StoredEvent<D = Record<string, unknown>> {
  globalPosition: bigint;
  eventId: string;
  type: string;
  data: D;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  tags: string[];
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
  afterPosition?: bigint;
  /**
   * If true, only yields events up to the safe position (where no earlier
   * transaction can still commit below it). This prevents projection gaps
   * from out-of-order BIGSERIAL commits.
   * 
   * Default: false (for backward compatibility)
   * 
   * Set to true for projections and any stream-following logic that must
   * not skip events due to commit-order races.
   */
  useSafePosition?: boolean;
}

export type TagExtractor = (event: NewEvent) => string[];

/**
 * Symbol to mark event types that are intentionally untagged.
 * Use this in tagExtractors config when an event type should have no tags:
 * 
 * @example
 * const store = new PostgresEventStore({
 *   pool,
 *   tagExtractors: {
 *     GlobalSettingChanged: UNTAGGED,
 *   },
 * });
 */
export const UNTAGGED: unique symbol = Symbol('UNTAGGED');

export interface EventStore {
  load(query: Query): Promise<LoadResult>;
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]>;
  stream(query: Query, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
