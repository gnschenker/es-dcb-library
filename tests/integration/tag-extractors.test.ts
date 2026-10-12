import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, UNTAGGED, MissingTagExtractorError } from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  await resetDatabase(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('PostgresEventStore - Tag Extractors (Integration)', () => {
  it('throws when appending event with no extractor and no explicit tags', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {
        OrderCreated: (event) => [`order:${event.data['orderId']}`],
      },
    });

    await expect(
      store.append({
        type: 'OrderShipped',
        data: { orderId: 'o1' },
      })
    ).rejects.toThrow(MissingTagExtractorError);
  });

  it('allows appending with explicit tags when no extractor exists', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {},
    });

    const [event] = await store.append({
      type: 'OrderShipped',
      data: { orderId: 'o1' },
      tags: ['order:o1'],
    });

    expect(event).toBeDefined();
    expect(event!.tags).toEqual(['order:o1']);
  });

  it('allows appending events marked as UNTAGGED', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {
        SystemEvent: UNTAGGED,
      },
    });

    const [event] = await store.append({
      type: 'SystemEvent',
      data: { message: 'System starting' },
    });

    expect(event).toBeDefined();
    expect(event!.tags).toEqual([]);
  });

  it('merges explicit tags with extracted tags', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {
        OrderCreated: (event) => [`order:${event.data['orderId']}`],
      },
    });

    const [event] = await store.append({
      type: 'OrderCreated',
      data: { orderId: 'o1' },
      tags: ['customer:c1'],
    });

    expect(event).toBeDefined();
    expect(event!.tags).toHaveLength(2);
    expect(event!.tags).toContain('order:o1');
    expect(event!.tags).toContain('customer:c1');
  });

  it('deduplicates tags when explicit and extracted overlap', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {
        OrderCreated: (event) => [`order:${event.data['orderId']}`, 'verified'],
      },
    });

    const [event] = await store.append({
      type: 'OrderCreated',
      data: { orderId: 'o1' },
      tags: ['verified', 'customer:c1'],
    });

    expect(event).toBeDefined();
    expect(event!.tags).toHaveLength(3);
    expect(event!.tags.filter(t => t === 'verified')).toHaveLength(1);
    expect(event!.tags).toContain('order:o1');
    expect(event!.tags).toContain('customer:c1');
  });

  it('throws clear error message identifying missing event type', async () => {
    const store = new PostgresEventStore({
      pool,
      tagExtractors: {
        OrderCreated: (event) => [`order:${event.data['orderId']}`],
      },
    });

    try {
      await store.append({
        type: 'UnknownEvent',
        data: {},
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTagExtractorError);
      const e = err as MissingTagExtractorError;
      expect(e.eventType).toBe('UnknownEvent');
      expect(e.message).toContain('UnknownEvent');
      expect(e.message).toContain('no registered tag extractor');
    }
  });
});
