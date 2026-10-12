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
}

export type TagExtractor = (event: NewEvent) => string[];

export interface EventStore {
  load(query: Query): Promise<LoadResult>;
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]>;
  stream(query: Query, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
