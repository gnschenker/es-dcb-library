export { query } from './query/query-object.js';
export type { QueryDefinition } from './query/types.js';
export type {
  NewEvent,
  StoredEvent,
  LoadResult,
  AppendOptions,
  StreamOptions,
  EventStore,
} from './types.js';
export { PostgresEventStore } from './store/event-store.js';
export type { EventStoreConfig } from './store/event-store.js';
export { ConcurrencyError, EventStoreError } from './errors.js';
