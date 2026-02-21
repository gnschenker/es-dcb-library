import type { QueryDefinition } from './query/types.js';

export interface NewEvent<P = Record<string, unknown>> {
  type: string;
  payload: P;
  metadata?: Record<string, unknown>;
}

export interface StoredEvent<P = Record<string, unknown>> {
  globalPosition: bigint;
  eventId: string;
  type: string;
  payload: P;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface LoadResult {
  events: StoredEvent[];
  version: bigint;
}

export interface AppendOptions {
  query: QueryDefinition;
  expectedVersion: bigint;
  concurrencyQuery?: QueryDefinition;
}

export interface StreamOptions {
  batchSize?: number;
  afterPosition?: bigint;
}

export interface EventStore {
  load(query: QueryDefinition): Promise<LoadResult>;
  append(events: NewEvent | NewEvent[], options?: AppendOptions): Promise<StoredEvent[]>;
  stream(query: QueryDefinition, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
