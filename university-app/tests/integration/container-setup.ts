/**
 * Vitest setupFile for integration tests.
 *
 * With `singleFork: true`, one worker process runs all integration test files.
 * Vitest re-evaluates modules between test files (for isolation), but `process.env`
 * persists across evaluations. The `if (process.env['TEST_DATABASE_URL']) return` guard
 * ensures the container is started only once per worker lifetime.
 *
 * Container cleanup is handled by testcontainers' Ryuk reaper, which removes containers
 * when the test process exits — no explicit `container.stop()` is needed.
 */
import { beforeAll } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';

beforeAll(async () => {
  if (process.env['TEST_DATABASE_URL']) return; // already started by a previous test file

  const container = await new GenericContainer('postgres:15-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'testdb',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  process.env['TEST_DATABASE_URL'] = `postgresql://test:test@${host}:${port}/testdb`;

  const pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
  const store = new PostgresEventStore({ pool });
  await store.initializeSchema();
  await store.close();
}, 90_000);
