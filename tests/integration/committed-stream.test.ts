import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryAll, STREAM_CURSOR_ORIGIN } from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { applyProjectionSchema } from '../../src/projections/schema.js';
import { ProjectionManager } from '../../src/projections/manager.js';
import { defineProjection } from '../../src/projections/types.js';

let pool: pg.Pool;
let store: PostgresEventStore;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  if (!store) store = new PostgresEventStore({ pool });
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
});

async function collectCommitted(
  afterCursor = STREAM_CURSOR_ORIGIN,
): Promise<Array<{ type: string; globalPosition: bigint }>> {
  const out: Array<{ type: string; globalPosition: bigint }> = [];
  for await (const event of store.stream(queryAll(), { committedOnly: true, afterCursor })) {
    out.push({ type: event.type, globalPosition: event.globalPosition });
  }
  return out;
}

describe('PostgresEventStore - committed-only stream (Integration)', () => {
  it('does not yield higher position while lower position is still in-flight (nextval before insert)', async () => {
    const t = await pool.connect();
    const s = await pool.connect();

    try {
      await t.query('BEGIN');
      await s.query('BEGIN');

      const pRes = await t.query<{ p: string }>(
        `SELECT nextval(pg_get_serial_sequence('events', 'global_position'))::text AS p`,
      );
      const qRes = await s.query<{ q: string }>(
        `SELECT nextval(pg_get_serial_sequence('events', 'global_position'))::text AS q`,
      );
      const p = BigInt(pRes.rows[0]!.p);
      const q = BigInt(qRes.rows[0]!.q);
      expect(q).toBe(p + 1n);

      await s.query(
        `INSERT INTO events (global_position, type, data, metadata, tags)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [q.toString(), 'EventQ', { value: 'Q' }, null, ['tag:q']],
      );
      await t.query(
        `INSERT INTO events (global_position, type, data, metadata, tags)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
        [p.toString(), 'EventP', { value: 'P' }, null, ['tag:p']],
      );

      await s.query('COMMIT');

      expect(await collectCommitted()).toHaveLength(0);

      await t.query('COMMIT');

      const all = await collectCommitted();
      expect(all).toHaveLength(2);
      expect(all[0]!.type).toBe('EventP');
      expect(all[0]!.globalPosition).toBe(p);
      expect(all[1]!.type).toBe('EventQ');
      expect(all[1]!.globalPosition).toBe(q);
    } finally {
      await t.query('ROLLBACK').catch(() => undefined);
      await s.query('ROLLBACK').catch(() => undefined);
      t.release();
      s.release();
    }
  });

  it('reproduces out-of-order commit: unsafe stream sees B; committed stream waits for A', async () => {
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      await client1.query('BEGIN');
      const result1 = await client1.query(
        `INSERT INTO events (type, data, metadata, tags)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)
         RETURNING global_position`,
        ['EventA', { value: 'A' }, null, ['tag:a']],
      );
      const pos1 = BigInt(result1.rows[0]!.global_position);
      expect(pos1).toBe(1n);

      await client2.query('BEGIN');
      const result2 = await client2.query(
        `INSERT INTO events (type, data, metadata, tags)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)
         RETURNING global_position`,
        ['EventB', { value: 'B' }, null, ['tag:b']],
      );
      const pos2 = BigInt(result2.rows[0]!.global_position);
      expect(pos2).toBe(2n);
      await client2.query('COMMIT');

      const unsafe: string[] = [];
      for await (const event of store.stream(queryAll(), { afterPosition: 0n })) {
        unsafe.push(event.type);
      }
      expect(unsafe).toEqual(['EventB']);

      expect(await collectCommitted()).toHaveLength(0);

      await client1.query('COMMIT');

      const committed = await collectCommitted();
      expect(committed.map((e) => e.type)).toEqual(['EventA', 'EventB']);
    } finally {
      await client1.query('ROLLBACK').catch(() => undefined);
      await client2.query('ROLLBACK').catch(() => undefined);
      client1.release();
      client2.release();
    }
  });

  it('committed stream with afterCursor continues from checkpoint correctly', async () => {
    await store.append([
      { type: 'Event1', data: { value: 1 }, tags: ['tag:1'] },
      { type: 'Event2', data: { value: 2 }, tags: ['tag:2'] },
    ]);

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      await client1.query('BEGIN');
      await client1.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event3', { value: 3 }, null, ['tag:3']],
      );

      await client2.query('BEGIN');
      await client2.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event4', { value: 4 }, null, ['tag:4']],
      );
      await client2.query('COMMIT');

      const afterTwo = await collectCommitted();
      expect(afterTwo.map((e) => e.type)).toEqual(['Event1', 'Event2']);

      const row = await pool.query<{ tx_id: string }>(
        `SELECT tx_id::text FROM events WHERE global_position = 2`,
      );
      const resumeCursor = { txId: row.rows[0]!.tx_id, globalPosition: 2n };

      expect(await collectCommitted(resumeCursor)).toHaveLength(0);

      await client1.query('COMMIT');

      const tail = await collectCommitted(resumeCursor);
      expect(tail.map((e) => e.type)).toEqual(['Event3', 'Event4']);
    } finally {
      client1.release();
      client2.release();
    }
  });

  it('projections catch up after rolled-back insert burns a sequence value', async () => {
    const schemaClient = await pool.connect();
    try {
      await applyProjectionSchema(schemaClient);
      await schemaClient.query('TRUNCATE projection_checkpoints');
    } finally {
      schemaClient.release();
    }

    const projection = defineProjection({
      name: 'rollback-liveness',
      query: queryAll(),
      setup: async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS proj_event_types (
            global_position BIGINT PRIMARY KEY,
            type TEXT NOT NULL
          )
        `);
      },
      handler: async (event, client) => {
        await client.query(
          `INSERT INTO proj_event_types (global_position, type)
           VALUES ($1, $2)
           ON CONFLICT (global_position) DO UPDATE SET type = EXCLUDED.type`,
          [event.globalPosition.toString(), event.type],
        );
      },
    });

    const manager = new ProjectionManager({ pool, store, projections: [projection] });
    await manager.initialize();
    manager.start();
    await manager.waitUntilLive(30_000);

    const first = await store.append({ type: 'First', data: {}, tags: ['t'] });
    const pos1 = first[0]!.globalPosition;

    const burner = await pool.connect();
    try {
      await burner.query('BEGIN');
      await burner.query(
        `INSERT INTO events (type, data, metadata, tags)
         VALUES ($1, $2::jsonb, NULL, $3)`,
        ['Burned', {}, ['burn']],
      );
      await burner.query('ROLLBACK');
    } finally {
      burner.release();
    }

    const second = await store.append({ type: 'Second', data: {}, tags: ['t'] });
    const pos2 = second[0]!.globalPosition;
    expect(pos2).toBeGreaterThan(pos1 + 1n);

    await manager.waitForPosition('rollback-liveness', pos2, 30_000);

    const rows = await pool.query<{ type: string; global_position: string }>(
      `SELECT type, global_position::text FROM proj_event_types ORDER BY global_position`,
    );
    expect(rows.rows.map((r) => r.type)).toEqual(['First', 'Second']);
    expect(rows.rows).toHaveLength(2);

    await manager.stop();
  });
});
