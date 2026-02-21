import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';

let container: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  container = await new GenericContainer('postgres:15-alpine')
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
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
