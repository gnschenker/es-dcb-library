export { PostgresEventStore } from './store/event-store.js';
export type { EventStoreConfig } from './store/event-store.js';
export { applySchema } from './store/schema.js';

export { query, queryAll, queryItem } from './query/index.js';
export type { Query, QueryItem } from './query/index.js';

export type {
  NewEvent,
  StoredEvent,
  LoadResult,
  AppendCondition,
  StreamOptions,
  TagExtractor,
  EventStore,
} from './types.js';

export { ConcurrencyError, EventStoreError } from './errors.js';
