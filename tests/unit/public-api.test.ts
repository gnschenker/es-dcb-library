import { describe, it, expect } from 'vitest';
import {  query, queryItem } from '../../src/index.js';

describe('Public API exports', () => {
  it('exports query builder', () => {
    expect(query).toBeDefined();
    expect(queryItem).toBeDefined();
  });

  it('exports PostgresEventStore', async () => {
    const { PostgresEventStore } = await import('../../src/index.js');
    expect(PostgresEventStore).toBeDefined();
  });

  it('exports error classes', async () => {
    const {
      ConcurrencyError,
      EventStoreError,
      EmptyBatchError,
      InvalidTagError,
      LockTimeoutError,
      ProjectionNotReadyError,
    } = await import('../../src/index.js');
    expect(ConcurrencyError).toBeDefined();
    expect(EventStoreError).toBeDefined();
    expect(EmptyBatchError).toBeDefined();
    expect(InvalidTagError).toBeDefined();
    expect(LockTimeoutError).toBeDefined();
    expect(ProjectionNotReadyError).toBeDefined();
  });

  it('exports observability helpers', async () => {
    const {
      createObservability,
      INSTRUMENTATION_SCOPE_NAME,
      INSTRUMENTATION_VERSION,
    } = await import('../../src/index.js');
    expect(createObservability).toBeDefined();
    expect(INSTRUMENTATION_SCOPE_NAME).toBe('es-dcb-library');
    expect(INSTRUMENTATION_VERSION).toBeDefined();
  });

  it('exports types', async () => {
    // Type-only exports verified at compile time
    const mod = await import('../../src/index.js');
    expect(mod).toBeDefined();
  });
});

describe('Query API', () => {
  it('query() creates valid queries', () => {
    const q = query([{ types: ['EventA'], tags: ['tag1'] }]);
    expect(q.items).toHaveLength(1);
  });

  it('queryItem() is a convenience wrapper', () => {
    const q = queryItem({ types: ['EventA'] });
    expect(q.items).toHaveLength(1);
  });
});
