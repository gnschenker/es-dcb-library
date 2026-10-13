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
export function compileExistsQuery(query: Query, after?: StreamCursor): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  let positionClause = '';
  if (after !== undefined) {
    params.push(after.txId);
    counter.n += 1;
    const afterTxRef = `$${counter.n}`;

    params.push(after.globalPosition);
    counter.n += 1;
    const afterPosRef = `$${counter.n}`;

    positionClause =
      ` AND ((tx_id, global_position) > (${afterTxRef}::xid8, ${afterPosRef})` +
      ` OR (${afterPosRef} > 0 AND global_position < ${afterPosRef}))`;
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
 * Extracts all (type, tag) pairs from a Query for locking.
 * Returns pairs in sorted order to prevent deadlocks.
 * 
 * For items with empty types (any type), uses '*' as the type.
 * For items with empty tags, uses '' as the tag.
 */
export function extractLockPairs(query: Query): Array<{ type: string; tag: string }> {
  const pairs = new Set<string>();
  
  for (const item of query.items) {
    const types = item.types ?? [];
    const tags = item.tags ?? [];
    
    // If no types specified, lock on '*' (any type)
    const typesToLock = types.length > 0 ? types : ['*'];
    
    // If no tags specified, lock on '' (empty tag)
    const tagsToLock = tags.length > 0 ? tags : [''];
    
    // Cartesian product of types and tags
    for (const type of typesToLock) {
      for (const tag of tagsToLock) {
        pairs.add(JSON.stringify({ type, tag }));
      }
    }
  }
  
  const result = Array.from(pairs).map((s) => JSON.parse(s) as { type: string; tag: string });
  return sortLockPairs(result);
}

function sortLockPairs(pairs: Array<{ type: string; tag: string }>): Array<{ type: string; tag: string }> {
  pairs.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    return typeCmp !== 0 ? typeCmp : a.tag.localeCompare(b.tag);
  });
  return pairs;
}

/**
 * Lock pairs for events being appended: Cartesian product of event type and each resolved tag.
 */
export function extractLockPairsFromEvents(
  events: Array<{ type: string; tags: string[] }>,
): Array<{ type: string; tag: string }> {
  const pairs = new Set<string>();

  for (const event of events) {
    const tagsToLock = event.tags.length > 0 ? event.tags : [''];
    for (const tag of tagsToLock) {
      pairs.add(JSON.stringify({ type: event.type, tag }));
    }
  }

  const result = Array.from(pairs).map((s) => JSON.parse(s) as { type: string; tag: string });
  return sortLockPairs(result);
}

/**
 * Union of lock pair lists (deduped, sorted).
 */
export function mergeLockPairs(
  ...lists: Array<Array<{ type: string; tag: string }>>
): Array<{ type: string; tag: string }> {
  const pairs = new Set<string>();
  for (const list of lists) {
    for (const pair of list) {
      pairs.add(JSON.stringify(pair));
    }
  }
  const result = Array.from(pairs).map((s) => JSON.parse(s) as { type: string; tag: string });
  return sortLockPairs(result);
}
