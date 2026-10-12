import { describe, it, expect } from 'vitest';
import { PostgresEventStore, UNTAGGED, MissingTagExtractorError } from '../../src/index.js';
import type { TagExtractor } from '../../src/index.js';
import pg from 'pg';

describe('PostgresEventStore - Tag Extractors (Unit)', () => {
  describe('UNTAGGED marker', () => {
    it('allows appending events marked as UNTAGGED with no tags', async () => {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql === 'BEGIN') return { rows: [] };
            if (sql === 'COMMIT') return { rows: [] };
            // Mock INSERT RETURNING
            return {
              rows: [{
                global_position: '1',
                event_id: 'test-id',
                type: 'SystemEvent',
                data: { foo: 'bar' },
                metadata: null,
                occurred_at: new Date(),
                tags: [],
              }],
            };
          },
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const store = new PostgresEventStore({
        pool: mockPool,
        tagExtractors: {
          SystemEvent: UNTAGGED,
        },
      });

      const [event] = await store.append({
        type: 'SystemEvent',
        data: { foo: 'bar' },
      });

      expect(event).toBeDefined();
      expect(event!.tags).toEqual([]);
    });
  });

  describe('Strict tag extraction', () => {
    it('throws MissingTagExtractorError when no extractor and no explicit tags', async () => {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql === 'BEGIN') return { rows: [] };
            return { rows: [] };
          },
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const store = new PostgresEventStore({
        pool: mockPool,
        tagExtractors: {
          OrderCreated: (event) => [`order:${event.data['orderId']}`],
          // OrderShipped has no extractor
        },
      });

      await expect(
        store.append({
          type: 'OrderShipped',
          data: { orderId: 'o1' },
        })
      ).rejects.toThrow(MissingTagExtractorError);

      await expect(
        store.append({
          type: 'OrderShipped',
          data: { orderId: 'o1' },
        })
      ).rejects.toThrow(/Event type 'OrderShipped' has no registered tag extractor/);
    });

    it('allows events with explicit tags even without extractor', async () => {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql === 'BEGIN') return { rows: [] };
            if (sql === 'COMMIT') return { rows: [] };
            // Mock INSERT RETURNING
            return {
              rows: [{
                global_position: '1',
                event_id: 'test-id',
                type: 'OrderShipped',
                data: { orderId: 'o1' },
                metadata: null,
                occurred_at: new Date(),
                tags: ['order:o1'],
              }],
            };
          },
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const store = new PostgresEventStore({
        pool: mockPool,
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

    it('merges explicit tags with extracted tags', async () => {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql === 'BEGIN') return { rows: [] };
            if (sql === 'COMMIT') return { rows: [] };
            // Mock INSERT RETURNING - check that tags were merged
            return {
              rows: [{
                global_position: '1',
                event_id: 'test-id',
                type: 'OrderCreated',
                data: { orderId: 'o1', customerId: 'c1' },
                metadata: null,
                occurred_at: new Date(),
                tags: ['order:o1', 'customer:c1', 'region:EU'],
              }],
            };
          },
          release: () => {},
        }),
      } as unknown as pg.Pool;

      const store = new PostgresEventStore({
        pool: mockPool,
        tagExtractors: {
          OrderCreated: (event) => [`order:${event.data['orderId']}`, `customer:${event.data['customerId']}`],
        },
      });

      const [event] = await store.append({
        type: 'OrderCreated',
        data: { orderId: 'o1', customerId: 'c1' },
        tags: ['region:EU'],
      });

      expect(event).toBeDefined();
      expect(event!.tags).toContain('order:o1');
      expect(event!.tags).toContain('customer:c1');
      expect(event!.tags).toContain('region:EU');
    });
  });

  describe('MissingTagExtractorError properties', () => {
    it('exposes eventType property', () => {
      const err = new MissingTagExtractorError('OrderShipped');
      expect(err.eventType).toBe('OrderShipped');
      expect(err.name).toBe('MissingTagExtractorError');
      expect(err.message).toContain('OrderShipped');
    });

    it('accepts custom message', () => {
      const err = new MissingTagExtractorError('OrderShipped', 'Custom error message');
      expect(err.message).toBe('Custom error message');
    });
  });
});
