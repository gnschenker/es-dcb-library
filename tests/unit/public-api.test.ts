import { describe, it, expect } from 'vitest';

describe('Public API surface', () => {
  it('exports query object', async () => {
    const { query } = await import('../../src/index.js');
    expect(typeof query.eventsOfType).toBe('function');
    expect(typeof query.allEventsOfType).toBe('function');
  });

  it('exports PostgresEventStore class', async () => {
    const { PostgresEventStore } = await import('../../src/index.js');
    expect(typeof PostgresEventStore).toBe('function'); // class is a function
  });

  it('exports ConcurrencyError as a class usable with instanceof', async () => {
    const { ConcurrencyError } = await import('../../src/index.js');
    const err = new ConcurrencyError(0n, 1n);
    expect(err).toBeInstanceOf(ConcurrencyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConcurrencyError');
  });

  it('exports EventStoreError as a class usable with instanceof', async () => {
    const { EventStoreError } = await import('../../src/index.js');
    const err = new EventStoreError('test error');
    expect(err).toBeInstanceOf(EventStoreError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EventStoreError');
  });

  it('does NOT export compileLoadQuery (internal)', async () => {
    const api = await import('../../src/index.js');
    expect((api as Record<string, unknown>)['compileLoadQuery']).toBeUndefined();
  });

  it('does NOT export mapRow (internal)', async () => {
    const api = await import('../../src/index.js');
    expect((api as Record<string, unknown>)['mapRow']).toBeUndefined();
  });

  it('does NOT export ClauseBuilder (internal)', async () => {
    const api = await import('../../src/index.js');
    expect((api as Record<string, unknown>)['ClauseBuilder']).toBeUndefined();
  });

  it('query.eventsOfType returns a valid QueryDefinition', async () => {
    const { query } = await import('../../src/index.js');
    const q = query.eventsOfType('TestType');
    expect(q._clauses).toHaveLength(1);
    expect(q._clauses[0]!.type).toBe('TestType');
  });
});
