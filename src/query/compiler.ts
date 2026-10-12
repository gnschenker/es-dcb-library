import type { Query, QueryItem } from './types.js';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

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
 */
export function compileLoadQuery(query: Query): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    'SELECT global_position, event_id, type, data, metadata, occurred_at, tags',
    'FROM events',
    whereClause,
    'ORDER BY global_position ASC',
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a Query into a version check query: SELECT COALESCE(MAX(global_position), 0).
 */
export function compileVersionCheckQuery(query: Query): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    'SELECT COALESCE(MAX(global_position), 0) AS max_pos',
    'FROM events',
    whereClause,
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a Query into a keyset-paginated SELECT query.
 */
export function compileStreamQuery(
  query: Query,
  afterPosition: bigint,
  batchSize: number,
  maxPosition?: bigint,
): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  params.push(afterPosition);
  counter.n += 1;
  const afterRef = `$${counter.n}`;

  let positionConstraint = `global_position > ${afterRef}`;
  if (maxPosition !== undefined) {
    params.push(maxPosition);
    counter.n += 1;
    const maxRef = `$${counter.n}`;
    positionConstraint += ` AND global_position <= ${maxRef}`;
  }

  params.push(batchSize);
  counter.n += 1;
  const limitRef = `$${counter.n}`;

  const sql = [
    'SELECT global_position, event_id, type, data, metadata, occurred_at, tags',
    'FROM events',
    `${whereClause} AND ${positionConstraint}`,
    'ORDER BY global_position ASC',
    `LIMIT ${limitRef}`,
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a Query into an existence check:
 * SELECT EXISTS (SELECT 1 FROM events WHERE <query> AND global_position > $after LIMIT 1)
 * 
 * Used for append condition: fails if any matching event exists after the specified position.
 */
export function compileExistsQuery(query: Query, after?: bigint): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);
  
  let positionClause = '';
  if (after !== undefined) {
    params.push(after);
    counter.n += 1;
    positionClause = ` AND global_position > $${counter.n}`;
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
  
  // Parse back and sort
  const result = Array.from(pairs).map(s => JSON.parse(s) as { type: string; tag: string });
  result.sort((a, b) => {
    const typeCmp = a.type.localeCompare(b.type);
    return typeCmp !== 0 ? typeCmp : a.tag.localeCompare(b.tag);
  });
  
  return result;
}
