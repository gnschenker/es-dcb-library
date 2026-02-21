import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';

export function createStore(connectionString: string): PostgresEventStore {
  return new PostgresEventStore({ pool: new pg.Pool({ connectionString }) });
}
