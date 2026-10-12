import { afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';
import type { EventStore } from 'es-dcb-library';
import { tagExtractors } from '../../src/store.js';

export function createTestStore(): EventStore {
  return new PostgresEventStore({
    pool: new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] }),
    tagExtractors,
  });
}

// Lazy pool for TRUNCATE — created on first use to avoid module-load-time issues
// (TEST_DATABASE_URL is set by setupFiles beforeAll before any test file runs)
let _adminPool: pg.Pool | undefined;

function getAdminPool(): pg.Pool {
  if (_adminPool === undefined) {
    _adminPool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
  }
  return _adminPool;
}

export async function clearEvents(): Promise<void> {
  await getAdminPool().query('TRUNCATE events RESTART IDENTITY CASCADE');
}

afterAll(async () => {
  await _adminPool?.end();
});
