import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';
import type { EventStore } from 'es-dcb-library';

export function createStore(connectionString: string): EventStore {
  return new PostgresEventStore({ pool: new pg.Pool({ connectionString }) });
}
