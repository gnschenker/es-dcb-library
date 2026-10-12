import { describe, it, expect } from 'vitest';
import {
  compileLoadQuery,
  compileVersionCheckQuery,
  compileStreamQuery,
  compileCommittedStreamQuery,
  compileExistsQuery,
  extractLockPairs,
} from '../../src/query/compiler.js';
import { query, queryAll, queryItem } from '../../src/query/builder.js';

describe('compileLoadQuery()', () => {
  it('compiles a single-item query with types and tags', () => {
    const q = queryItem({ types: ['EventA'], tags: ['tag1', 'tag2'] });
    const { sql, params } = compileLoadQuery(q);
    
    expect(sql).toContain('SELECT global_position, event_id, type, data, metadata, occurred_at, tags');
    expect(sql).toContain('FROM events');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('ORDER BY global_position ASC');
    expect(sql).toContain('type = ANY($1)');
    expect(sql).toContain('tags @> $2');
    expect(params).toHaveLength(2);
    expect(params[0]).toEqual(['EventA']);
    expect(params[1]).toEqual(['tag1', 'tag2']);
  });

  it('compiles a query with types only (no tags)', () => {
    const q = queryItem({ types: ['EventA', 'EventB'] });
    const { sql, params } = compileLoadQuery(q);
    
    expect(sql).toContain('type = ANY($1)');
    expect(sql).not.toContain('tags @>');
    expect(params).toEqual([['EventA', 'EventB']]);
  });

  it('compiles a query with tags only (any type)', () => {
    const q = queryItem({ tags: ['tag1'] });
    const { sql, params } = compileLoadQuery(q);
    
    expect(sql).toContain('tags @> $1');
    expect(sql).not.toContain('type = ANY');
    expect(params).toEqual([['tag1']]);
  });

  it('compiles queryAll (matches all events)', () => {
    const q = queryAll();
    const { sql, params } = compileLoadQuery(q);
    
    expect(sql).toContain('WHERE TRUE');
    expect(params).toHaveLength(0);
  });

  it('compiles multi-item query with OR', () => {
    const q = query([
      { types: ['EventA'], tags: ['tag1'] },
      { types: ['EventB'], tags: ['tag2'] },
    ]);
    const { sql, params } = compileLoadQuery(q);
    
    expect(sql).toContain('WHERE (');
    expect(sql).toContain('OR');
    expect(params).toHaveLength(4);
    expect(params[0]).toEqual(['EventA']);
    expect(params[1]).toEqual(['tag1']);
    expect(params[2]).toEqual(['EventB']);
    expect(params[3]).toEqual(['tag2']);
  });

  it('combines type and tags with AND within an item', () => {
    const q = queryItem({ types: ['EventA'], tags: ['tag1'] });
    const { sql } = compileLoadQuery(q);
    
    expect(sql).toMatch(/type = ANY.*AND.*tags @>/);
  });
});

describe('compileVersionCheckQuery()', () => {
  it('compiles to COALESCE(MAX(global_position), 0)', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileVersionCheckQuery(q);
    
    expect(sql).toContain('SELECT COALESCE(MAX(global_position), 0) AS max_pos');
    expect(sql).toContain('FROM events');
    expect(sql).toContain('WHERE');
    expect(sql).not.toContain('ORDER BY');
    expect(params).toEqual([['EventA']]);
  });
});

describe('compileCommittedStreamQuery()', () => {
  it('filters committed rows and orders by (tx_id, global_position)', () => {
    const q = queryAll();
    const { sql, params } = compileCommittedStreamQuery(
      q,
      { txId: '100', globalPosition: 5n },
      25,
    );

    expect(sql).toContain('tx_id < pg_snapshot_xmin(pg_current_snapshot())');
    expect(sql).toContain('(tx_id, global_position) > ($1::xid8, $2)');
    expect(sql).toContain('ORDER BY tx_id ASC, global_position ASC');
    expect(sql).toContain('LIMIT $3');
    expect(params).toEqual(['100', 5n, 25]);
  });
});

describe('compileStreamQuery()', () => {
  it('includes position and limit parameters', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileStreamQuery(q, 100n, 50);
    
    expect(sql).toContain('global_position > $2');
    expect(sql).toContain('LIMIT $3');
    expect(params).toHaveLength(3);
    expect(params[0]).toEqual(['EventA']);
    expect(params[1]).toBe(100n);
    expect(params[2]).toBe(50);
  });

  it('orders by global_position ASC', () => {
    const q = queryAll();
    const { sql } = compileStreamQuery(q, 0n, 100);
    
    expect(sql).toContain('ORDER BY global_position ASC');
  });
});

describe('compileExistsQuery()', () => {
  it('compiles to EXISTS subquery without after', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileExistsQuery(q);
    
    expect(sql).toContain('SELECT EXISTS');
    expect(sql).toContain('SELECT 1');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('global_position >');
    expect(params).toEqual([['EventA']]);
  });

  it('includes position constraint when after is specified', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileExistsQuery(q, 42n);
    
    expect(sql).toContain('global_position > $2');
    expect(params).toHaveLength(2);
    expect(params[1]).toBe(42n);
  });
});

describe('extractLockPairs()', () => {
  it('extracts all (type, tag) combinations from query', () => {
    const q = query([
      { types: ['EventA'], tags: ['tag1', 'tag2'] },
    ]);
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(2);
    expect(pairs).toContainEqual({ type: 'EventA', tag: 'tag1' });
    expect(pairs).toContainEqual({ type: 'EventA', tag: 'tag2' });
  });

  it('uses "*" for empty types (any type)', () => {
    const q = queryItem({ tags: ['tag1'] });
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ type: '*', tag: 'tag1' });
  });

  it('uses "" for empty tags', () => {
    const q = queryItem({ types: ['EventA'] });
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ type: 'EventA', tag: '' });
  });

  it('handles queryAll (any type, no tags)', () => {
    const q = queryAll();
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ type: '*', tag: '' });
  });

  it('sorts pairs deterministically (type then tag)', () => {
    const q = query([
      { types: ['EventB'], tags: ['z'] },
      { types: ['EventA'], tags: ['b', 'a'] },
    ]);
    const pairs = extractLockPairs(q);
    
    expect(pairs).toEqual([
      { type: 'EventA', tag: 'a' },
      { type: 'EventA', tag: 'b' },
      { type: 'EventB', tag: 'z' },
    ]);
  });

  it('deduplicates pairs', () => {
    const q = query([
      { types: ['EventA'], tags: ['tag1'] },
      { types: ['EventA'], tags: ['tag1'] },
    ]);
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ type: 'EventA', tag: 'tag1' });
  });

  it('handles multiple types and tags (Cartesian product)', () => {
    const q = queryItem({ types: ['A', 'B'], tags: ['t1', 't2'] });
    const pairs = extractLockPairs(q);
    
    expect(pairs).toHaveLength(4);
    expect(pairs).toContainEqual({ type: 'A', tag: 't1' });
    expect(pairs).toContainEqual({ type: 'A', tag: 't2' });
    expect(pairs).toContainEqual({ type: 'B', tag: 't1' });
    expect(pairs).toContainEqual({ type: 'B', tag: 't2' });
  });
});
