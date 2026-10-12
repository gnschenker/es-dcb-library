import { describe, it, expect, vi } from 'vitest';
import { defineProjection, createEventDispatcher } from '../../src/projections/types.js';
import type { ProjectionDefinition } from '../../src/projections/types.js';
import { queryItem } from '../../src/index.js';
import type { StoredEvent } from '../../src/types.js';
import type pg from 'pg';

const validQuery = queryItem({ types: ['TestEvent'] });

// Minimal mock StoredEvent
function mockEvent(type: string, data: Record<string, unknown> = {}): StoredEvent {
  return {
    globalPosition: 1n,
    eventId: 'test-event-id',
    type,
    data,
    metadata: null,
    occurredAt: new Date(),
    tags: [],
    txId: '1',
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

  it('throws when query.items is empty', () => {
    const emptyQuery = { items: [] } as any;
    expect(() => defineProjection({ name: 'test', query: emptyQuery, handler: async () => {} }))
      .toThrow('at least one item');
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
  it('dispatches to the correct handler by event type', async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    
    const dispatcher = createEventDispatcher({
      EventA: handlerA,
      EventB: handlerB,
    });

    await dispatcher(mockEvent('EventA', { x: 1 }), mockClient());
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('passes data (not payload) to the handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createEventDispatcher({ TestEvent: handler });
    
    const event = mockEvent('TestEvent', { key: 'value' });
    await dispatcher(event, mockClient());
    
    expect(handler).toHaveBeenCalledWith({ key: 'value' }, event, mockClient());
  });

  it('passes the full event as second argument', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createEventDispatcher({ TestEvent: handler });
    
    const event = mockEvent('TestEvent');
    await dispatcher(event, mockClient());
    
    expect(handler).toHaveBeenCalledWith(expect.anything(), event, expect.anything());
  });

  it('passes the client as third argument', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createEventDispatcher({ TestEvent: handler });
    
    const client = mockClient();
    await dispatcher(mockEvent('TestEvent'), client);
    
    expect(handler).toHaveBeenCalledWith(expect.anything(), expect.anything(), client);
  });

  it('silently skips events with no matching handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createEventDispatcher({ KnownEvent: handler });
    
    await dispatcher(mockEvent('UnknownEvent'), mockClient());
    
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates handler errors', async () => {
    const error = new Error('Handler failed');
    const handler = vi.fn().mockRejectedValue(error);
    const dispatcher = createEventDispatcher({ TestEvent: handler });
    
    await expect(dispatcher(mockEvent('TestEvent'), mockClient())).rejects.toThrow('Handler failed');
  });

  it('handles multiple event types', async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    const handlerC = vi.fn().mockResolvedValue(undefined);
    
    const dispatcher = createEventDispatcher({
      EventA: handlerA,
      EventB: handlerB,
      EventC: handlerC,
    });

    await dispatcher(mockEvent('EventB'), mockClient());
    expect(handlerB).toHaveBeenCalled();
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerC).not.toHaveBeenCalled();
  });
});
