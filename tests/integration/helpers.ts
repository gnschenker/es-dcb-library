import pg from 'pg';
import { applySchema } from '../../src/store/schema.js';

export function createTestPool(): pg.Pool {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL is not set — did globalSetup run?');
  }
  return new pg.Pool({ connectionString, max: 5 });
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await applySchema(client);
    await client.query('TRUNCATE events RESTART IDENTITY CASCADE');
  } finally {
    client.release();
  }
}

export async function seedEvents(
  pool: pg.Pool,
  events: Array<{ type: string; data: object; metadata?: object; tags?: string[] }>,
): Promise<void> {
  for (const event of events) {
    await pool.query(
      `INSERT INTO events (type, data, metadata, tags)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
      [
        event.type,
        JSON.stringify(event.data),
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.tags ?? [],
      ],
    );
  }
}
