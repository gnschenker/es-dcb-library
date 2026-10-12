import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryItem, query, UNTAGGED } from '../../src/index.js';
import { createTestPool, resetDatabase } from './helpers.js';

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

describe('PostgresEventStore - Tag Model (Integration)', () => {
  describe('Schema and basic append', () => {
    it('appends events with tags', async () => {
      const [stored] = await store.append({
        type: 'OrderCreated',
        data: { orderId: 'o1' },
        tags: ['order:o1', 'customer:c1'],
      });

      expect(stored!.type).toBe('OrderCreated');
      expect(stored!.tags).toEqual(['order:o1', 'customer:c1']);
      expect(stored!.data).toEqual({ orderId: 'o1' });
      expect(stored!.globalPosition).toBeGreaterThan(0n);
    });

    it('rejects append without extractor, explicit tags, or UNTAGGED marker', async () => {
      await expect(
        store.append({
          type: 'EventWithoutTags',
          data: {},
        }),
      ).rejects.toThrow(/no registered tag extractor/);

      const storeWithUntagged = new PostgresEventStore({
        pool,
        tagExtractors: { EventWithoutTags: UNTAGGED },
      });
      const [stored] = await storeWithUntagged.append({
        type: 'EventWithoutTags',
        data: {},
      });
      expect(stored!.tags).toEqual([]);
    });
  });

  describe('Tag-based queries', () => {
    beforeEach(async () => {
      await store.append([
        { type: 'OrderCreated', data: { orderId: 'o1' }, tags: ['order:o1', 'customer:c1'] },
        { type: 'OrderCreated', data: { orderId: 'o2' }, tags: ['order:o2', 'customer:c1'] },
        { type: 'OrderShipped', data: { orderId: 'o1' }, tags: ['order:o1'] },
        { type: 'PaymentReceived', data: { orderId: 'o1' }, tags: ['order:o1', 'customer:c1'] },
        { type: 'OrderCreated', data: { orderId: 'o3' }, tags: ['order:o3', 'customer:c2'] },
      ]);
    });

    it('queries by single type', async () => {
      const q = queryItem({ types: ['OrderCreated'] });
      const { events } = await store.load(q);

      expect(events).toHaveLength(3);
      expect(events.every(e => e.type === 'OrderCreated')).toBe(true);
    });

    it('queries by single tag (any type)', async () => {
      const q = queryItem({ tags: ['order:o1'] });
      const { events } = await store.load(q);

      expect(events).toHaveLength(3);
      expect(events.map(e => e.type)).toEqual(['OrderCreated', 'OrderShipped', 'PaymentReceived']);
      expect(events.every(e => e.tags.includes('order:o1'))).toBe(true);
    });

    it('queries by type AND tags', async () => {
      const q = queryItem({ types: ['OrderCreated'], tags: ['customer:c1'] });
      const { events } = await store.load(q);

      expect(events).toHaveLength(2);
      expect(events.every(e => e.type === 'OrderCreated')).toBe(true);
      expect(events.every(e => e.tags.includes('customer:c1'))).toBe(true);
    });

    it('queries with multiple types (OR)', async () => {
      const q = queryItem({ types: ['OrderCreated', 'OrderShipped'] });
      const { events } = await store.load(q);

      expect(events).toHaveLength(4);
    });

    it('queries with multiple tags (AND within item)', async () => {
      const q = queryItem({ tags: ['order:o1', 'customer:c1'] });
      const { events } = await store.load(q);

      expect(events).toHaveLength(2); // OrderCreated and PaymentReceived for o1
      expect(events.every(e => e.tags.includes('order:o1') && e.tags.includes('customer:c1'))).toBe(true);
    });

    it('queries with multiple items (OR at top level)', async () => {
      const q = query([
        { types: ['OrderShipped'] },
        { tags: ['customer:c2'] },
      ]);
      const { events } = await store.load(q);

      expect(events).toHaveLength(2); // OrderShipped + OrderCreated for c2
    });
  });

  describe('Tag extractors', () => {
    it('derives tags from event data via registered extractor', async () => {
      const storeWithExtractors = new PostgresEventStore({
        pool,
        tagExtractors: {
          OrderCreated: (event) => [
            `order:${event.data['orderId']}`,
            `customer:${event.data['customerId']}`,
          ],
        },
      });

      const [stored] = await storeWithExtractors.append({
        type: 'OrderCreated',
        data: { orderId: 'o1', customerId: 'c1' },
        tags: [], // Empty, will be filled by extractor
      });

      expect(stored!.tags).toContain('order:o1');
      expect(stored!.tags).toContain('customer:c1');
    });

    it('merges explicit tags with extracted tags', async () => {
      const storeWithExtractors = new PostgresEventStore({
        pool,
        tagExtractors: {
          OrderCreated: (event) => [`order:${event.data['orderId']}`],
        },
      });

      const [stored] = await storeWithExtractors.append({
        type: 'OrderCreated',
        data: { orderId: 'o1' },
        tags: ['manual:tag'],
      });

      expect(stored!.tags).toContain('order:o1');
      expect(stored!.tags).toContain('manual:tag');
    });
  });

  describe('Append condition', () => {
    it('fails when matching events exist after specified position', async () => {
      const [event1] = await store.append({
        type: 'OrderCreated',
        data: {},
        tags: ['order:o1'],
      });

      await store.append({
        type: 'OrderShipped',
        data: {},
        tags: ['order:o1'],
      });

      const q = queryItem({ tags: ['order:o1'] });

      // Try to append with outdated position
      await expect(
        store.append(
          { type: 'OrderCancelled', data: {}, tags: ['order:o1'] },
          { failIfEventsMatch: q, after: event1!.globalPosition }
        )
      ).rejects.toThrow();
    });

    it('succeeds when no matching events exist after position', async () => {
      const [event1] = await store.append({
        type: 'OrderCreated',
        data: {},
        tags: ['order:o1'],
      });

      await store.append({
        type: 'UnrelatedEvent',
        data: {},
        tags: ['other:tag'],
      });

      const q = queryItem({ tags: ['order:o1'] });

      // Should succeed because no order:o1 events after event1
      await expect(
        store.append(
          { type: 'OrderShipped', data: {}, tags: ['order:o1'] },
          { failIfEventsMatch: q, after: event1!.globalPosition }
        )
      ).resolves.toBeDefined();
    });
  });

  describe('Overlapping queries with tag-based locking', () => {
    it('serializes concurrent writes with blocking locks (only real conflicts fail)', async () => {
      // With blocking locks, concurrent writers wait for each other
      // Only one that detects a real conflict (stale version) gets ConcurrencyError
      const results: string[] = [];

      const writer = async (id: string) => {
        const q = queryItem({ tags: ['order:o1'] });
        const { version } = await store.load(q);
        
        // Simulate some work
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Both writers start with version 0. Due to blocking locks:
        // - First writer acquires lock, checks condition (passes), inserts, commits, releases lock
        // - Second writer waits for lock, acquires it, checks condition (fails - sees first writer's event), throws
        try {
          await store.append(
            { type: `Writer${id}`, data: {}, tags: ['order:o1', `writer:${id}`] },
            { failIfEventsMatch: q, after: version }
          );
          results.push(`success:${id}`);
        } catch (err) {
          if (err instanceof Error && err.message.includes('Append condition failed')) {
            results.push(`conflict:${id}`);
          } else {
            throw err;
          }
        }
      };

      // Both try to append concurrently
      await Promise.all([writer('1'), writer('2')]);

      // One succeeds, one gets real conflict
      expect(results).toHaveLength(2);
      expect(results.filter(r => r.startsWith('success'))).toHaveLength(1);
      expect(results.filter(r => r.startsWith('conflict'))).toHaveLength(1);

      // Verify only one event is in the store
      const finalEvents = await store.load(queryItem({ tags: ['order:o1'] }));
      expect(finalEvents.events).toHaveLength(1);
    });

    it('prevents conflicting appends to overlapping queries', async () => {
      // Seed an initial event
      await store.append({
        type: 'InitialEvent',
        data: {},
        tags: ['order:o1'],
      });

      const { version } = await store.load(queryItem({ tags: ['order:o1'] }));

      // Append another event
      await store.append({
        type: 'SecondEvent',
        data: {},
        tags: ['order:o1'],
      });

      // Try to append with stale version - should fail
      await expect(
        store.append(
          { type: 'StaleAppend', data: {}, tags: ['order:o1'] },
          { failIfEventsMatch: queryItem({ tags: ['order:o1'] }), after: version }
        )
      ).rejects.toThrow('Append condition failed');
    });

    it('two different but overlapping queries race - only one succeeds', async () => {
      // This is the critical test: two queries that overlap but are different
      // Query 1: All events for order:o1 (any tags, just needs order:o1)
      // Query 2: Events with both order:o1 AND customer:c1
      // 
      // Both writers will append events with BOTH tags, so:
      // - Writer1's query (order:o1) will match Writer2's event (has order:o1)
      // - Writer2's query (order:o1 + customer:c1) will match Writer1's event (has both)
      //
      // With tag-based locking, both acquire locks on order:o1 and customer:c1
      // (even though Writer1's query doesn't require customer:c1, Writer1's EVENT has it)
      // One succeeds, one sees the other's event and gets conflict

      const results: string[] = [];

      // Query 1: All events for order:o1
      const writer1 = async () => {
        const q = queryItem({ tags: ['order:o1'] });
        const { version } = await store.load(q);
        await new Promise(resolve => setTimeout(resolve, 10));
        
        try {
          // Event has BOTH tags even though query only requires order:o1
          await store.append(
            { type: 'OrderEvent', data: {}, tags: ['order:o1', 'customer:c1'] },
            { failIfEventsMatch: q, after: version }
          );
          results.push('writer1:success');
        } catch (err) {
          if (err instanceof Error && err.message.includes('Append condition failed')) {
            results.push('writer1:conflict');
          } else {
            throw err;
          }
        }
      };

      // Query 2: Events with both customer:c1 AND order:o1
      const writer2 = async () => {
        const q = queryItem({ tags: ['order:o1', 'customer:c1'] });
        const { version } = await store.load(q);
        await new Promise(resolve => setTimeout(resolve, 10));
        
        try {
          // Event has both tags, matching the query
          await store.append(
            { type: 'CustomerOrderEvent', data: {}, tags: ['order:o1', 'customer:c1'] },
            { failIfEventsMatch: q, after: version }
          );
          results.push('writer2:success');
        } catch (err) {
          if (err instanceof Error && err.message.includes('Append condition failed')) {
            results.push('writer2:conflict');
          } else {
            throw err;
          }
        }
      };

      // Race them
      await Promise.all([writer1(), writer2()]);

      // Both queries share locks on (type:*, tag:order:o1) and (type:*, tag:customer:c1)
      // One succeeds, one sees the other's event and gets conflict
      expect(results).toHaveLength(2);
      expect(results.filter(r => r.includes('success'))).toHaveLength(1);
      expect(results.filter(r => r.includes('conflict'))).toHaveLength(1);

      // Only one event appended
      const allEvents = await store.load(queryItem({ tags: ['order:o1'] }));
      expect(allEvents.events).toHaveLength(1);
    });
  });
});
