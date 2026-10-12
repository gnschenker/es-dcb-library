import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore } from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';
import { queryAll } from '../../src/index.js';

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

describe('PostgresEventStore - Out-of-Order Commit Safety (Integration)', () => {
  it('reproduces the out-of-order commit problem with BIGSERIAL', async () => {
    // This test demonstrates the gap problem:
    // 1. Transaction T1 starts, gets position 1
    // 2. Transaction T2 starts, gets position 2
    // 3. T2 commits first
    // 4. If we stream with useSafePosition: false and stop after position 2, we miss event 1

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      // T1: Begin and insert event (gets position 1, but don't commit yet)
      await client1.query('BEGIN');
      const result1 = await client1.query(
        `INSERT INTO events (type, data, metadata, tags)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)
         RETURNING global_position`,
        ['EventA', { value: 'A' }, null, ['tag:a']]
      );
      const pos1 = BigInt(result1.rows[0]!.global_position);
      expect(pos1).toBe(1n);

      // T2: Begin, insert, and commit (gets position 2, commits first)
      await client2.query('BEGIN');
      const result2 = await client2.query(
        `INSERT INTO events (type, data, metadata, tags)
         VALUES ($1, $2::jsonb, $3::jsonb, $4)
         RETURNING global_position`,
        ['EventB', { value: 'B' }, null, ['tag:b']]
      );
      const pos2 = BigInt(result2.rows[0]!.global_position);
      expect(pos2).toBe(2n);
      await client2.query('COMMIT');

      // At this point, position 2 is committed, but position 1 is not
      // If we stream without safety, we'd see EventB but not EventA

      // Stream WITHOUT safe position (should see EventB immediately)
      const unsafeEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { useSafePosition: false })) {
        unsafeEvents.push(event);
      }
      expect(unsafeEvents).toHaveLength(1);
      expect(unsafeEvents[0]!.type).toBe('EventB');
      expect(unsafeEvents[0]!.globalPosition).toBe(2n);

      // Stream WITH safe position (should see nothing yet, because position 1 is uncommitted)
      const safeEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { useSafePosition: true })) {
        safeEvents.push(event);
      }
      expect(safeEvents).toHaveLength(0); // No events safe to read yet

      // Now commit T1
      await client1.query('COMMIT');

      // Stream WITH safe position (should now see both events in order)
      const safeEventsAfterCommit: any[] = [];
      for await (const event of store.stream(queryAll(), { useSafePosition: true })) {
        safeEventsAfterCommit.push(event);
      }
      expect(safeEventsAfterCommit).toHaveLength(2);
      expect(safeEventsAfterCommit[0]!.type).toBe('EventA');
      expect(safeEventsAfterCommit[0]!.globalPosition).toBe(1n);
      expect(safeEventsAfterCommit[1]!.type).toBe('EventB');
      expect(safeEventsAfterCommit[1]!.globalPosition).toBe(2n);
    } finally {
      client1.release();
      client2.release();
    }
  });

  it('safe position prevents projections from skipping events', async () => {
    // Simulate a projection reading events while transactions commit out of order
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    const client3 = await pool.connect();

    try {
      // Setup: commit event at position 1
      await client1.query('BEGIN');
      await client1.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event1', { value: 1 }, null, ['tag:1']]
      );
      await client1.query('COMMIT');

      // T2: Start transaction for position 2 but don't commit
      await client2.query('BEGIN');
      await client2.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event2', { value: 2 }, null, ['tag:2']]
      );

      // T3: Start and commit transaction for position 3
      await client3.query('BEGIN');
      await client3.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event3', { value: 3 }, null, ['tag:3']]
      );
      await client3.query('COMMIT');

      // Stream with safe position: should only see event 1 (position 2 is uncommitted)
      const safeEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { afterPosition: 0n, useSafePosition: true })) {
        safeEvents.push(event);
      }
      expect(safeEvents).toHaveLength(1);
      expect(safeEvents[0]!.type).toBe('Event1');

      // Now commit T2
      await client2.query('COMMIT');

      // Stream again: should now see all three events in order
      const allEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { afterPosition: 0n, useSafePosition: true })) {
        allEvents.push(event);
      }
      expect(allEvents).toHaveLength(3);
      expect(allEvents[0]!.type).toBe('Event1');
      expect(allEvents[1]!.type).toBe('Event2');
      expect(allEvents[2]!.type).toBe('Event3');
    } finally {
      client1.release();
      client2.release();
      client3.release();
    }
  });

  it('safe position with afterPosition continues from checkpoint correctly', async () => {
    // Commit events 1 and 2
    await store.append([
      { type: 'Event1', data: { value: 1 }, tags: ['tag:1'] },
      { type: 'Event2', data: { value: 2 }, tags: ['tag:2'] },
    ]);

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      // T1: Start transaction for position 3 but don't commit
      await client1.query('BEGIN');
      await client1.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event3', { value: 3 }, null, ['tag:3']]
      );

      // T2: Commit position 4
      await client2.query('BEGIN');
      await client2.query(
        `INSERT INTO events (type, data, metadata, tags) VALUES ($1, $2::jsonb, $3::jsonb, $4)`,
        ['Event4', { value: 4 }, null, ['tag:4']]
      );
      await client2.query('COMMIT');

      // Stream from position 2 with safe position: should see nothing (position 3 uncommitted)
      const safeEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { afterPosition: 2n, useSafePosition: true })) {
        safeEvents.push(event);
      }
      expect(safeEvents).toHaveLength(0);

      // Commit T1
      await client1.query('COMMIT');

      // Stream again: should see events 3 and 4
      const allEvents: any[] = [];
      for await (const event of store.stream(queryAll(), { afterPosition: 2n, useSafePosition: true })) {
        allEvents.push(event);
      }
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]!.type).toBe('Event3');
      expect(allEvents[1]!.type).toBe('Event4');
    } finally {
      client1.release();
      client2.release();
    }
  });
});
