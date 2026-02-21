import { describe, it, expect } from 'vitest';
import { mapRow, type EventRow } from '../../src/store/row-mapper.js';
import type { StoredEvent } from '../../src/types.js';

const baseRow: EventRow = {
  global_position: '42',
  event_id: 'test-uuid-1234',
  type: 'OrderCreated',
  payload: { orderId: 'o1', customerId: 'c1' },
  metadata: { correlationId: 'corr-1' },
  occurred_at: new Date('2024-01-01T00:00:00.000Z'),
};

describe('mapRow', () => {
  describe('Basic field mapping', () => {
    it('maps all fields to correct StoredEvent property names', () => {
      const result = mapRow(baseRow);

      expect(result).toHaveProperty('globalPosition');
      expect(result).toHaveProperty('eventId');
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('metadata');
      expect(result).toHaveProperty('occurredAt');
    });

    it('maps global_position string "42" to BigInt 42n', () => {
      const result = mapRow({ ...baseRow, global_position: '42' });
      expect(result.globalPosition).toBe(42n);
    });

    it('maps event_id to eventId', () => {
      const result = mapRow({ ...baseRow, event_id: 'some-uuid' });
      expect(result.eventId).toBe('some-uuid');
    });

    it('maps occurred_at to occurredAt as a Date instance', () => {
      const date = new Date('2024-01-01T00:00:00.000Z');
      const result = mapRow({ ...baseRow, occurred_at: date });
      expect(result.occurredAt).toBeInstanceOf(Date);
      expect(result.occurredAt).toEqual(date);
    });

    it('maps type field correctly', () => {
      const result = mapRow({ ...baseRow, type: 'OrderShipped' });
      expect(result.type).toBe('OrderShipped');
    });
  });

  describe('BigInt precision', () => {
    it('converts global_position "1" to 1n', () => {
      const result = mapRow({ ...baseRow, global_position: '1' });
      expect(result.globalPosition).toBe(1n);
    });

    it('converts global_position "0" to 0n (edge case: zero)', () => {
      const result = mapRow({ ...baseRow, global_position: '0' });
      expect(result.globalPosition).toBe(0n);
    });

    it('correctly converts value above Number.MAX_SAFE_INTEGER (9007199254740993)', () => {
      // Number.MAX_SAFE_INTEGER = 9007199254740991 (2^53 - 1)
      // 9007199254740993 = 2^53 + 1, which parseInt() would corrupt
      const result = mapRow({ ...baseRow, global_position: '9007199254740993' });
      // BigInt preserves the exact value
      expect(result.globalPosition).toBe(9007199254740993n);
      // Verify result is not the imprecise parseInt value (which would be 9007199254740992n)
      expect(result.globalPosition).not.toBe(9007199254740992n);
      // Show parseInt loses precision: it returns 9007199254740992, not the exact value
      // We compare BigInt(parseInt(...)) to BigInt(exact) to prove they differ
      expect(BigInt(parseInt('9007199254740993', 10))).toBe(9007199254740992n);
      expect(BigInt(parseInt('9007199254740993', 10))).not.toBe(9007199254740993n);
    });
  });

  describe('Metadata handling', () => {
    it('preserves metadata: null as null (not undefined, not {})', () => {
      const result = mapRow({ ...baseRow, metadata: null });
      expect(result.metadata).toBeNull();
    });

    it('preserves metadata object with values', () => {
      const result = mapRow({ ...baseRow, metadata: { correlationId: 'x' } });
      expect(result.metadata).toEqual({ correlationId: 'x' });
    });

    it('preserves empty metadata object as {} (not null)', () => {
      const result = mapRow({ ...baseRow, metadata: {} });
      expect(result.metadata).toEqual({});
      expect(result.metadata).not.toBeNull();
    });
  });

  describe('Payload handling', () => {
    it('preserves empty payload as {}', () => {
      const result = mapRow({ ...baseRow, payload: {} });
      expect(result.payload).toEqual({});
    });

    it('preserves deeply nested payload structure', () => {
      const payload = { nested: { deep: true } };
      const result = mapRow({ ...baseRow, payload });
      expect(result.payload).toEqual({ nested: { deep: true } });
    });

    it('preserves falsy number 0 in payload (not coerced to falsy)', () => {
      const payload = { count: 0 };
      const result = mapRow({ ...baseRow, payload });
      expect(result.payload).toEqual({ count: 0 });
      expect((result.payload as { count: number }).count).toBe(0);
    });
  });

  describe('Type preservation', () => {
    it('result is assignable to StoredEvent', () => {
      const result = mapRow(baseRow);
      // Type assertion — if this compiles, the type is correct
      const _: StoredEvent = result;
      expect(_).toBeDefined();
    });

    it('globalPosition is of type bigint', () => {
      const result = mapRow(baseRow);
      expect(typeof result.globalPosition).toBe('bigint');
    });

    it('occurredAt is an instance of Date', () => {
      const result = mapRow(baseRow);
      expect(result.occurredAt).toBeInstanceOf(Date);
    });
  });
});
