import { describe, it, expect } from 'vitest';
import {
  compileLoadQuery,
  compileLoadCommittedQuery,
  compileTailCommittedCursorQuery,
  compileStreamQuery,
  compileCommittedStreamQuery,
  compileExistsQuery,
  compileStreamTagExistsQuery,
  streamTagsFromQuery,
  extractConditionLockKeys,
  extractEventLockKeys,
  compileAppendLockRequests,
  lockKeyString,
  compareLockKeyStrings,
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

describe('compileLoadCommittedQuery()', () => {
  it('filters committed rows and orders by (tx_id, global_position)', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileLoadCommittedQuery(q);

    expect(sql).toContain('tx_id < pg_snapshot_xmin(pg_current_snapshot())');
    expect(sql).toContain('ORDER BY tx_id ASC, global_position ASC');
    expect(params).toEqual([['EventA']]);
  });
});

describe('compileTailCommittedCursorQuery()', () => {
  it('selects tail committed cursor', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql } = compileTailCommittedCursorQuery(q);

    expect(sql).toContain('ORDER BY tx_id DESC, global_position DESC');
    expect(sql).toContain('LIMIT 1');
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

  it('includes commit-safe cursor constraint when after is specified', () => {
    const q = queryItem({ types: ['EventA'] });
    const { sql, params } = compileExistsQuery(q, {
      txId: '99',
      globalPosition: 42n,
      readXmin: '1000',
    });

    expect(sql).toContain('(tx_id, global_position) > ($2::xid8, $3)');
    expect(sql).toContain('global_position < $3');
    expect(sql).toContain('tx_id >= $4::xid8');
    expect(params).toHaveLength(4);
    expect(params[1]).toBe('99');
    expect(params[2]).toBe(42n);
    expect(params[3]).toBe('1000');
  });
});

describe('compareLockKeyStrings()', () => {
  it('uses UTF-16 code-unit order, not localeCompare', () => {
    expect(compareLockKeyStrings('A', 'a')).toBe(-1);
    expect(compareLockKeyStrings('a', 'A')).toBe(1);
    expect(compareLockKeyStrings('all', 'all')).toBe(0);
    expect(compareLockKeyStrings('tag:A', 'tag:a')).toBe(-1);
    // Would reorder under some locales if localeCompare were used.
    expect(compareLockKeyStrings('tag:Z', 'tag:ä')).toBe(compareLockKeyStrings('Z', 'ä'));
    expect(compareLockKeyStrings('tag:Z', 'tag:ä')).toBe('Z' < 'ä' ? -1 : 1);
  });
});

describe('extractConditionLockKeys()', () => {
  it('locks each tag and ignores types when the item has tags', () => {
    const q = query([{ types: ['EventA'], tags: ['tag1', 'tag2'] }]);
    expect(extractConditionLockKeys(q)).toEqual([
      { kind: 'tag', tag: 'tag1' },
      { kind: 'tag', tag: 'tag2' },
    ]);
  });

  it('locks tag only for a type-wildcard item', () => {
    const q = queryItem({ tags: ['board:B1'] });
    expect(extractConditionLockKeys(q)).toEqual([{ kind: 'tag', tag: 'board:B1' }]);
  });

  it('locks each type when the item has types and no tags', () => {
    const q = queryItem({ types: ['EventA', 'EventB'] });
    expect(extractConditionLockKeys(q)).toEqual([
      { kind: 'type', type: 'EventA' },
      { kind: 'type', type: 'EventB' },
    ]);
  });

  it('locks all for queryAll', () => {
    expect(extractConditionLockKeys(queryAll())).toEqual([{ kind: 'all' }]);
  });

  it('sorts keys by lockKeyString', () => {
    const q = query([
      { types: ['EventB'], tags: ['z'] },
      { types: ['EventA'], tags: ['b', 'a'] },
    ]);
    expect(extractConditionLockKeys(q).map(lockKeyString)).toEqual([
      'tag:a',
      'tag:b',
      'tag:z',
    ]);
  });

  it('deduplicates keys', () => {
    const q = query([
      { types: ['EventA'], tags: ['tag1'] },
      { types: ['EventB'], tags: ['tag1'] },
    ]);
    expect(extractConditionLockKeys(q)).toEqual([{ kind: 'tag', tag: 'tag1' }]);
  });
});

describe('extractEventLockKeys()', () => {
  it('locks each tag, the event type, and all', () => {
    expect(extractEventLockKeys([{ type: 'ChapterAdded', tags: ['board:B1'] }])).toEqual([
      { kind: 'all' },
      { kind: 'tag', tag: 'board:B1' },
      { kind: 'type', type: 'ChapterAdded' },
    ]);
  });

  it('still locks type and all for an untagged event', () => {
    expect(extractEventLockKeys([{ type: 'SystemEvent', tags: [] }])).toEqual([
      { kind: 'all' },
      { kind: 'type', type: 'SystemEvent' },
    ]);
  });
});

describe('compileAppendLockRequests()', () => {
  it('shares tag:board:B1 for *:board vs ChapterAdded:board', () => {
    const wildcard = compileAppendLockRequests(queryItem({ tags: ['board:B1'] }), [
      { type: 'ChapterAdded', tags: ['board:B1'] },
    ]);
    const typed = compileAppendLockRequests(
      queryItem({ types: ['ChapterAdded'], tags: ['board:B1'] }),
      [{ type: 'ChapterAdded', tags: ['board:B1'] }],
    );

    expect(wildcard).toContainEqual({ key: { kind: 'tag', tag: 'board:B1' }, mode: 'exclusive' });
    expect(typed).toContainEqual({ key: { kind: 'tag', tag: 'board:B1' }, mode: 'exclusive' });
    expect(wildcard.find((r) => r.key.kind === 'all')?.mode).toBe('shared');
    expect(typed.find((r) => r.key.kind === 'all')?.mode).toBe('shared');
  });

  it('takes exclusive all for a match-all condition and exclusive type for a tagless type item', () => {
    const matchAll = compileAppendLockRequests(queryAll(), [
      { type: 'Anything', tags: ['other:x'] },
    ]);
    const taglessType = compileAppendLockRequests(queryItem({ types: ['ChapterAdded'] }), [
      { type: 'ChapterAdded', tags: ['board:B1'] },
    ]);

    expect(matchAll.find((r) => r.key.kind === 'all')).toEqual({
      key: { kind: 'all' },
      mode: 'exclusive',
    });
    expect(taglessType).toContainEqual({
      key: { kind: 'type', type: 'ChapterAdded' },
      mode: 'exclusive',
    });
    expect(taglessType.find((r) => r.key.kind === 'all')?.mode).toBe('shared');
  });

  it('sorts with compareLockKeyStrings, not localeCompare', () => {
    const requests = compileAppendLockRequests(
      queryItem({ tags: ['Z', 'ä'] }),
      [{ type: 'T', tags: [] }],
    );
    const keys = requests.map((r) => lockKeyString(r.key));
    const sorted = [...keys].sort(compareLockKeyStrings);
    expect(keys).toEqual(sorted);
  });

  it('acquires keys in sorted lockKeyString order', () => {
    const requests = compileAppendLockRequests(
      queryItem({ types: ['TypeZ'], tags: ['tag-high', 'extra-a'] }),
      [{ type: 'TypeA', tags: ['tag-low'] }],
    );
    expect(requests.map((r) => lockKeyString(r.key))).toEqual([
      'all',
      'tag:extra-a',
      'tag:tag-high',
      'tag:tag-low',
      'type:TypeA',
    ]);
  });
});

describe('compileStreamTagExistsQuery()', () => {
  it('uses global_position for tag stream invalidation', () => {
    const { sql, params } = compileStreamTagExistsQuery('my-tag', {
      txId: '1',
      globalPosition: 5n,
      readXmin: '99',
    });
    expect(sql).toContain('tags @> $1');
    expect(sql).toContain('global_position > $2');
    expect(sql).not.toContain('readXmin');
    expect(sql).not.toContain('tx_id, global_position');
    expect(params).toEqual([['my-tag'], 5n]);
  });
});

describe('streamTagsFromQuery()', () => {
  it('returns distinct tags from query items', () => {
    expect(streamTagsFromQuery(queryItem({ types: ['A'], tags: ['t1', 't2'] }))).toEqual(['t1', 't2']);
  });
});
