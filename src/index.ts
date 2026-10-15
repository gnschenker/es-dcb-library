export { PostgresEventStore } from './store/event-store.js';
export type { EventStoreConfig } from './store/event-store.js';
export { applySchema } from './store/schema.js';

export { query, queryAll, queryItem, combineQueries } from './query/index.js';
export type { Query, QueryItem } from './query/index.js';

export type {
  NewEvent,
  StoredEvent,
  LoadResult,
  AppendCondition,
  StreamOptions,
  StreamCursor,
  TagExtractor,
  EventStore,
} from './types.js';

export { UNTAGGED, STREAM_CURSOR_ORIGIN, eventStreamCursor, isConsistentStreamCursor } from './types.js';

export {
  ConcurrencyError,
  EventStoreError,
  MissingTagExtractorError,
  EmptyBatchError,
  InconsistentStreamCursorError,
  InvalidTagError,
  LockTimeoutError,
  DeadlockError,
  SerializationFailureError,
  ProjectionNotReadyError,
  ProjectionSetupTimeoutError,
  errorFromPg,
} from './errors.js';

export type { ObservabilityConfig, DcbObservability } from './observability/index.js';
export {
  createObservability,
  INSTRUMENTATION_SCOPE_NAME,
  INSTRUMENTATION_VERSION,
} from './observability/index.js';
