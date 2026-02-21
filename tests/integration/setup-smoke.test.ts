import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestPool, resetDatabase, seedEvents } from './helpers.js';
import type pg from 'pg';

let pool: pg.Pool;

beforeAll(() => {
  pool = createTestPool();
});

afterAll(async () => {
  await pool.end();
});

describe('integration test infrastructure', () => {
  it('TEST_DATABASE_URL is defined', () => {
    expect(process.env['TEST_DATABASE_URL']).toBeDefined();
    expect(process.env['TEST_DATABASE_URL']).toMatch(/^postgres(ql)?:\/\//);
  });

  it('createTestPool returns a pool that can execute SELECT 1', async () => {
    const result = await pool.query('SELECT 1 AS value');
    expect(result.rows[0]).toEqual({ value: 1 });
  });

  it('resetDatabase runs without error on a fresh DB', async () => {
    await expect(resetDatabase(pool)).resolves.not.toThrow();
  });

  it('resetDatabase is idempotent — safe to call twice', async () => {
    await resetDatabase(pool);
    await expect(resetDatabase(pool)).resolves.not.toThrow();
  });

  it('seedEvents inserts rows readable via raw query', async () => {
    await resetDatabase(pool);
    await seedEvents(pool, [
      { type: 'TestEvent', payload: { value: 42 } },
      { type: 'TestEvent', payload: { value: 99 }, metadata: { source: 'test' } },
    ]);
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM events');
    expect(result.rows[0]).toEqual({ count: 2 });
  });

  it('resetDatabase after seedEvents clears the table', async () => {
    await resetDatabase(pool);
    await seedEvents(pool, [{ type: 'TestEvent', payload: { x: 1 } }]);
    await resetDatabase(pool);
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM events');
    expect(result.rows[0]).toEqual({ count: 0 });
  });
});
