import { describe, it, expect, vi } from 'vitest';
import { defineProjection, createEventDispatcher } from '../../src/projections/types.js';
import type { ProjectionDefinition } from '../../src/projections/types.js';
import { query } from '../../src/query/query-object.js';
import type { StoredEvent } from '../../src/types.js';
import type pg from 'pg';

const validQuery = query.eventsOfType('TestEvent');

// Minimal mock StoredEvent
function mockEvent(type: string, payload: Record<string, unknown> = {}): StoredEvent {
  return {
    globalPosition: 1n,
    eventId: 'test-event-id',
    type,
    payload,
    metadata: null,
    occurredAt: new Date(),
  };
}

// Minimal mock pg.PoolClient
function mockClient(): pg.PoolClient {
  return {} as pg.PoolClient;
}

describe('defineProjection()', () => {
  it('returns the definition unchanged when valid', () => {
    const def = { name: 'my-projection', query: validQuery, handler: async () => {} };
    expect(defineProjection(def)).toBe(def);
  });

  it('throws when name is empty string', () => {
    expect(() => defineProjection({ name: '', query: validQuery, handler: async () => {} }))
      .toThrow('name must be a non-empty string');
  });

  it('throws when name is whitespace-only', () => {
    expect(() => defineProjection({ name: '   ', query: validQuery, handler: async () => {} }))
      .toThrow('name must be a non-empty string');
  });

  it('throws when name does not match naming convention (starts with digit)', () => {
    expect(() => defineProjection({ name: '1bad-name', query: validQuery, handler: async () => {} }))
      .toThrow(/must match/);
  });

  it('throws when name is too long (> 128 chars)', () => {
    const longName = 'a' + 'x'.repeat(128); // 129 chars
    expect(() => defineProjection({ name: longName, query: validQuery, handler: async () => {} }))
      .toThrow(/must match/);
  });

  it('accepts names with hyphens and underscores', () => {
    const def = { name: 'teacher-read_model', query: validQuery, handler: async () => {} };
    expect(defineProjection(def)).toBe(def);
  });

  it('throws when query._clauses is empty', () => {
    // Build a query object with empty _clauses by using a cast
    const emptyQuery = { _clauses: [] } as any;
    expect(() => defineProjection({ name: 'test', query: emptyQuery, handler: async () => {} }))
      .toThrow('at least one event type');
  });

  it('accepts a definition without setup callback', () => {
    const def: ProjectionDefinition = { name: 'no-setup', query: validQuery, handler: async () => {} };
    expect(defineProjection(def)).toBe(def);
    expect(def.setup).toBeUndefined();
  });

  it('accepts a definition with setup callback', () => {
    const setup = async (_client: pg.PoolClient) => {};
    const def = { name: 'with-setup', query: validQuery, setup, handler: async () => {} };
    expect(defineProjection(def)).toBe(def);
  });
});

describe('createEventDispatcher()', () => {
  it('returns a ProjectionHandler function', () => {
    const handler = createEventDispatcher({});
    expect(typeof handler).toBe('function');
  });

  it('calls the matching sub-handler for a known event type', async () => {
    const subHandler = vi.fn().mockResolvedValue(undefined);
    const handler = createEventDispatcher({ TestEvent: subHandler });
    const event = mockEvent('TestEvent', { id: '1' });
    const client = mockClient();
    await handler(event, client);
    expect(subHandler).toHaveBeenCalledOnce();
    expect(subHandler).toHaveBeenCalledWith(event.payload, event, client);
  });

  it('silently skips events with no matching handler', async () => {
    const subHandler = vi.fn().mockResolvedValue(undefined);
    const handler = createEventDispatcher({ OtherEvent: subHandler });
    const event = mockEvent('UnknownEvent');
    await handler(event, mockClient());
    expect(subHandler).not.toHaveBeenCalled();
  });

  it('calls the correct sub-handler when multiple handlers are registered', async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createEventDispatcher({ EventA: handlerA, EventB: handlerB });
    await dispatcher(mockEvent('EventA'), mockClient());
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('passes payload, full event, and client to sub-handler', async () => {
    const subHandler = vi.fn().mockResolvedValue(undefined);
    const handler = createEventDispatcher({ MyEvent: subHandler });
    const event = mockEvent('MyEvent', { key: 'value' });
    const client = mockClient();
    await handler(event, client);
    expect(subHandler).toHaveBeenCalledWith({ key: 'value' }, event, client);
  });
});
