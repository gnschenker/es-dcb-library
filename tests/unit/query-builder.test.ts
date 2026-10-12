import { describe, it, expect } from 'vitest';
import { query, queryAll, queryItem, combineQueries } from '../../src/query/builder.js';
import type { Query, QueryItem } from '../../src/query/types.js';

describe('query()', () => {
  it('creates a query from a list of items', () => {
    const q = query([
      { types: ['EventA'], tags: ['tag1'] },
      { types: ['EventB'], tags: ['tag2'] },
    ]);
    expect(q.items).toHaveLength(2);
    expect(q.items[0]).toEqual({ types: ['EventA'], tags: ['tag1'] });
    expect(q.items[1]).toEqual({ types: ['EventB'], tags: ['tag2'] });
  });

  it('throws when items array is empty', () => {
    expect(() => query([])).toThrow('Query must have at least one item');
  });

  it('accepts items with empty types (any type)', () => {
    const q = query([{ tags: ['tag1'] }]);
    expect(q.items[0]).toEqual({ tags: ['tag1'] });
  });

  it('accepts items with empty tags', () => {
    const q = query([{ types: ['EventA'] }]);
    expect(q.items[0]).toEqual({ types: ['EventA'] });
  });

  it('accepts items with both types and tags empty (matches all)', () => {
    const q = query([{}]);
    expect(q.items[0]).toEqual({});
  });
});

describe('queryAll()', () => {
  it('creates a query that matches all events', () => {
    const q = queryAll();
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toEqual({});
  });
});

describe('queryItem()', () => {
  it('creates a query with a single item', () => {
    const q = queryItem({ types: ['EventA'], tags: ['tag1'] });
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toEqual({ types: ['EventA'], tags: ['tag1'] });
  });
});

describe('combineQueries()', () => {
  it('combines multiple queries into one by merging items', () => {
    const q1 = query([{ types: ['EventA'], tags: ['tag1'] }]);
    const q2 = query([{ types: ['EventB'], tags: ['tag2'] }]);
    const q3 = query([{ types: ['EventC'], tags: ['tag3'] }]);
    
    const combined = combineQueries(q1, q2, q3);
    
    expect(combined.items).toHaveLength(3);
    expect(combined.items[0]).toEqual({ types: ['EventA'], tags: ['tag1'] });
    expect(combined.items[1]).toEqual({ types: ['EventB'], tags: ['tag2'] });
    expect(combined.items[2]).toEqual({ types: ['EventC'], tags: ['tag3'] });
  });

  it('combines queries with multiple items each', () => {
    const q1 = query([
      { types: ['EventA'], tags: ['tag1'] },
      { types: ['EventB'], tags: ['tag1'] },
    ]);
    const q2 = query([
      { types: ['EventC'], tags: ['tag2'] },
    ]);
    
    const combined = combineQueries(q1, q2);
    
    expect(combined.items).toHaveLength(3);
    expect(combined.items[0]).toEqual({ types: ['EventA'], tags: ['tag1'] });
    expect(combined.items[1]).toEqual({ types: ['EventB'], tags: ['tag1'] });
    expect(combined.items[2]).toEqual({ types: ['EventC'], tags: ['tag2'] });
  });

  it('throws when called with no arguments', () => {
    expect(() => combineQueries()).toThrow('combineQueries requires at least one query');
  });

  it('works with single query (identity operation)', () => {
    const q = query([{ types: ['EventA'], tags: ['tag1'] }]);
    const combined = combineQueries(q);
    
    expect(combined.items).toHaveLength(1);
    expect(combined.items[0]).toEqual({ types: ['EventA'], tags: ['tag1'] });
  });
});

describe('Query type structure', () => {
  it('Query has readonly items array', () => {
    const q: Query = query([{ types: ['A'] }]);
    expect(q.items).toBeDefined();
    // TypeScript enforces readonly at compile time
  });

  it('QueryItem types and tags are readonly arrays', () => {
    const item: QueryItem = { types: ['A'], tags: ['t1'] };
    expect(item.types).toBeDefined();
    expect(item.tags).toBeDefined();
    // TypeScript enforces readonly at compile time
  });
});
