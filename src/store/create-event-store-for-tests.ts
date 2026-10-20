import { PostgresEventStore, type EventStoreConfig } from './event-store.js';
import { setLockScheduler, type LockScheduler } from './lock-scheduler.js';

/**
 * Test-only factory. Not re-exported from the package entry.
 * Installs a lock scheduler so tests can hold a transaction between acquires.
 */
export function createEventStoreForTests(
  config: EventStoreConfig,
  lockScheduler: LockScheduler,
): PostgresEventStore {
  const store = new PostgresEventStore(config);
  setLockScheduler(store, lockScheduler);
  return store;
}
