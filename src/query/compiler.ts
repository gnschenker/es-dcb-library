import type { Query, QueryItem } from './types.js';
import type { StreamCursor } from '../types.js';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

const EVENT_SELECT_COLUMNS =
  'global_position, event_id, type, data, metadata, occurred_at, tags, tx_id';

/**
 * Compiles a single QueryItem into a SQL WHERE fragment.
 * 
 * Match logic:
 * - types: event.type = ANY($n) OR $n = '{}' (empty array means any type)
 * - tags: event.tags @> $m (event has all required tags)
 */
function compileItem(
  item: QueryItem,
  params: unknown[],
  counter: { n: number },
): string {
  const conditions: string[] = [];
  
  // Type condition
  const types = item.types ?? [];
  if (types.length > 0) {
    params.push(types);
    counter.n += 1;
    conditions.push(`type = ANY($${counter.n})`);
  }
  // If types is empty or undefined, no type constraint (matches any type)
  
  // Tags condition
  const tags = item.tags ?? [];
  if (tags.length > 0) {
    params.push(tags);
    counter.n += 1;
    conditions.push(`tags @> $${counter.n}`);
  }
  
  if (conditions.length === 0) {
    // No constraints - matches all events
    return 'TRUE';
  }
  
  return conditions.length === 1 ? conditions[0]! : `(${conditions.join(' AND ')})`;
}

/**
 * Compiles a Query into a WHERE clause.
 * Items are OR'ed together.
 */
function compileWhereClause(
  query: Query,
  params: unknown[],
  counter: { n: number },
): string {
  if (query.items.length === 0) {
    throw new Error('Query must have at least one item');
  }
  
  const conditions = query.items.map(item => compileItem(item, params, counter));
  
  if (conditions.length === 1) {
    return `WHERE ${conditions[0]}`;
  }
  
  return `WHERE (${conditions.join(' OR ')})`;
}

/**
 * Compiles a Query into a full SELECT query ordered by global_position ASC.
 * @deprecated Internal legacy shape; `PostgresEventStore.load()` uses committed-only ordering.
 */
export function compileLoadQuery(query: Query): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    `SELECT ${EVENT_SELECT_COLUMNS}`,
    'FROM events',
    whereClause,
    'ORDER BY global_position ASC',
  ].join('\n');

  return { sql, params };
}

/**
 * Load matching events visible under the committed-only rule, ordered by (tx_id, global_position).
 */
export function compileLoadCommittedQuery(query: Query): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    `SELECT ${EVENT_SELECT_COLUMNS}`,
    'FROM events',
    `${whereClause}`,
    `AND tx_id < pg_snapshot_xmin(pg_current_snapshot())`,
    'ORDER BY tx_id ASC, global_position ASC',
  ].join('\n');

  return { sql, params };
}

/**
 * Tail (tx_id, global_position) among committed-visible rows matching the query.
 */
export function compileTailCommittedCursorQuery(query: Query): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    'SELECT tx_id::text AS tx_id, global_position',
    'FROM events',
    `${whereClause}`,
    `AND tx_id < pg_snapshot_xmin(pg_current_snapshot())`,
    'ORDER BY tx_id DESC, global_position DESC',
    'LIMIT 1',
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a Query into a keyset-paginated SELECT query (global_position order).
 */
export function compileStreamQuery(
  query: Query,
  afterPosition: bigint,
  batchSize: number,
): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  params.push(afterPosition);
  counter.n += 1;
  const afterRef = `$${counter.n}`;

  params.push(batchSize);
  counter.n += 1;
  const limitRef = `$${counter.n}`;

  const sql = [
    `SELECT ${EVENT_SELECT_COLUMNS}`,
    'FROM events',
    `${whereClause} AND global_position > ${afterRef}`,
    'ORDER BY global_position ASC',
    `LIMIT ${limitRef}`,
  ].join('\n');

  return { sql, params };
}

/**
 * Committed-only stream: tx_id < snapshot xmin, ordered by (tx_id, global_position).
 */
export function compileCommittedStreamQuery(
  query: Query,
  afterCursor: StreamCursor,
  batchSize: number,
): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  params.push(afterCursor.txId);
  counter.n += 1;
  const afterTxRef = `$${counter.n}`;

  params.push(afterCursor.globalPosition);
  counter.n += 1;
  const afterPosRef = `$${counter.n}`;

  params.push(batchSize);
  counter.n += 1;
  const limitRef = `$${counter.n}`;

  const sql = [
    `SELECT ${EVENT_SELECT_COLUMNS}`,
    'FROM events',
    `${whereClause}`,
    `AND tx_id < pg_snapshot_xmin(pg_current_snapshot())`,
    `AND (tx_id, global_position) > (${afterTxRef}::xid8, ${afterPosRef})`,
    'ORDER BY tx_id ASC, global_position ASC',
    `LIMIT ${limitRef}`,
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a Query into an existence check for append conditions.
 *
 * When `after` is set, fails if a matching row exists that invalidates the optimistic cursor:
 * - strictly after `(tx_id, global_position)`, or
 * - with `global_position` less than the watermark (late commit of an older transaction).
 */
export interface ExistsQueryOptions {
  /** Detect late commits below the watermark (uses `after.readXmin`). Default true. */
  lateCommitHoles?: boolean;
}

export function compileExistsQuery(
  query: Query,
  after?: StreamCursor,
  options: ExistsQueryOptions = {},
): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const lateCommitHoles = options.lateCommitHoles ?? true;

  let positionClause = '';
  if (after !== undefined) {
    params.push(after.txId);
    counter.n += 1;
    const afterTxRef = `$${counter.n}`;

    params.push(after.globalPosition);
    counter.n += 1;
    const afterPosRef = `$${counter.n}`;

    if (lateCommitHoles && after.readXmin !== undefined) {
      params.push(after.readXmin);
      counter.n += 1;
      const readXminRef = `$${counter.n}`;
      positionClause =
        ` AND ((tx_id, global_position) > (${afterTxRef}::xid8, ${afterPosRef})` +
        ` OR (${afterPosRef} > 0 AND global_position < ${afterPosRef} AND tx_id >= ${readXminRef}::xid8))`;
    } else {
      positionClause = ` AND (tx_id, global_position) > (${afterTxRef}::xid8, ${afterPosRef})`;
    }
  }

  const sql = [
    'SELECT EXISTS (',
    '  SELECT 1',
    '  FROM events',
    `  ${whereClause}${positionClause}`,
    '  LIMIT 1',
    ') AS exists',
  ].join('\n');

  return { sql, params };
}

/**
 * Any row with `tags @> {tag}` that invalidates the append cursor on the shared tag stream.
 * Uses `global_position` ordering (not `(tx_id, global_position)`), so multi-clause loads
 * are not confused by tuple ordering across unrelated types on the same tag.
 */
export function compileStreamTagExistsQuery(tag: string, after?: StreamCursor): CompiledQuery {
  const params: unknown[] = [[tag]];
  const counter = { n: 1 };

  let positionClause = '';
  if (after !== undefined) {
    params.push(after.globalPosition);
    counter.n += 1;
    const afterPosRef = `$${counter.n}`;
    // Position-only: avoids false conflicts on multi-tag loads (tuple / xmin holes stay on failIf exists).
    positionClause = ` AND global_position > ${afterPosRef}`;
  }

  const sql = [
    'SELECT EXISTS (',
    '  SELECT 1',
    '  FROM events',
    '  WHERE tags @> $1',
    `${positionClause}`,
    '  LIMIT 1',
    ') AS exists',
  ].join('\n');

  return { sql, params };
}

/** Distinct non-empty tags referenced by a query’s items. */
export function streamTagsFromQuery(query: Query): string[] {
  return [...new Set(query.items.flatMap((item) => item.tags ?? []).filter((t) => t !== ''))];
}

/**
 * Advisory-lock identity. Serialized with `lockKeyString` and hashed via `hashtext()`.
 *
 * Collision rule: any two transactions must share a key if one transaction’s
 * appended event could match the other’s `failIfEventsMatch`.
 */
export type LockKey =
  | { readonly kind: 'tag'; readonly tag: string }
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'all' };

export type LockMode = 'exclusive' | 'shared';

export interface LockRequest {
  readonly key: LockKey;
  readonly mode: LockMode;
}

/** `tag:<t>` | `type:<T>` | `all` — also the acquire-order sort key. */
export function lockKeyString(key: LockKey): string {
  switch (key.kind) {
    case 'tag':
      return `tag:${key.tag}`;
    case 'type':
      return `type:${key.type}`;
    case 'all':
      return 'all';
  }
}

function uniqueSortedKeys(keys: LockKey[]): LockKey[] {
  const map = new Map<string, LockKey>();
  for (const key of keys) {
    map.set(lockKeyString(key), key);
  }
  return [...map.values()].sort((a, b) => lockKeyString(a).localeCompare(lockKeyString(b)));
}

/**
 * Exclusive keys for a condition:
 * - item with tags → `tag:<t>` for each tag (types ignored)
 * - item with types and no tags → `type:<T>` for each type
 * - item with neither (match all) → `all`
 */
export function extractConditionLockKeys(query: Query): LockKey[] {
  const keys: LockKey[] = [];
  for (const item of query.items) {
    const types = item.types ?? [];
    const tags = item.tags ?? [];
    if (tags.length > 0) {
      for (const tag of tags) {
        keys.push({ kind: 'tag', tag });
      }
    } else if (types.length > 0) {
      for (const type of types) {
        keys.push({ kind: 'type', type });
      }
    } else {
      keys.push({ kind: 'all' });
    }
  }
  return uniqueSortedKeys(keys);
}

/**
 * Keys implied by events being appended: `tag:<t>` for each tag, `type:<T>`, and `all`.
 * `compileAppendLockRequests` takes `all` in shared mode so only a match-all
 * condition (exclusive `all`) serializes with every append.
 */
export function extractEventLockKeys(events: Array<{ type: string; tags: string[] }>): LockKey[] {
  const keys: LockKey[] = [];
  for (const event of events) {
    for (const tag of event.tags) {
      keys.push({ kind: 'tag', tag });
    }
    keys.push({ kind: 'type', type: event.type });
    keys.push({ kind: 'all' });
  }
  return uniqueSortedKeys(keys);
}

/**
 * Union of condition + event lock requests, exclusive except event-originated
 * `all` (shared). Exclusive wins when a match-all condition also wants `all`.
 * Sorted by `lockKeyString` to avoid deadlocks.
 */
export function compileAppendLockRequests(
  query: Query,
  events: Array<{ type: string; tags: string[] }>,
): LockRequest[] {
  const byKey = new Map<string, LockRequest>();

  const add = (key: LockKey, mode: LockMode): void => {
    const id = lockKeyString(key);
    const existing = byKey.get(id);
    if (existing === undefined || (existing.mode === 'shared' && mode === 'exclusive')) {
      byKey.set(id, { key, mode });
    }
  };

  for (const key of extractConditionLockKeys(query)) {
    add(key, 'exclusive');
  }
  for (const key of extractEventLockKeys(events)) {
    add(key, key.kind === 'all' ? 'shared' : 'exclusive');
  }

  return [...byKey.values()].sort((a, b) => lockKeyString(a.key).localeCompare(lockKeyString(b.key)));
}
