import type { QueryDefinition, FilterNode, Clause } from './types.js';

export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

/**
 * Compiles a FilterNode into a SQL fragment and appends parameters.
 * Uses a shared counter object so recursive calls share the same sequence.
 */
function compileFilterNode(
  node: FilterNode,
  params: unknown[],
  counter: { n: number },
): string {
  if (node.kind === 'attr') {
    params.push(JSON.stringify({ [node.key]: node.value }));
    counter.n += 1;
    return `payload @> $${counter.n}::jsonb`;
  }

  if (node.kind === 'and') {
    const parts = node.filters.map((f) => compileFilterNode(f, params, counter));
    return `(${parts.join(' AND ')})`;
  }

  // node.kind === 'or'
  const parts = node.filters.map((f) => compileFilterNode(f, params, counter));
  return `(${parts.join(' OR ')})`;
}

/**
 * Compiles a single Clause into a SQL fragment and appends parameters.
 */
function compileClause(
  clause: Clause,
  params: unknown[],
  counter: { n: number },
): string {
  params.push(clause.type);
  counter.n += 1;
  const typeRef = `$${counter.n}`;

  if (clause.filter === null) {
    return `type = ${typeRef}`;
  }

  const filterSQL = compileFilterNode(clause.filter, params, counter);
  return `(type = ${typeRef} AND ${filterSQL})`;
}

/**
 * Compiles all clauses of a QueryDefinition into a WHERE clause SQL fragment.
 */
function compileWhereClause(
  query: QueryDefinition,
  params: unknown[],
  counter: { n: number },
): string {
  const clauses = query._clauses;

  if (clauses.length === 1) {
    const clauseSQL = compileClause(clauses[0] as Clause, params, counter);
    return `WHERE ${clauseSQL}`;
  }

  const parts = clauses.map((clause) => compileClause(clause, params, counter));
  return `WHERE (${parts.join(' OR ')})`;
}

/**
 * Compiles a QueryDefinition into a full SELECT query ordered by global_position ASC.
 */
export function compileLoadQuery(query: QueryDefinition): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: 0 };
  const whereClause = compileWhereClause(query, params, counter);

  const sql = [
    'SELECT global_position, event_id, type, payload, metadata, occurred_at',
    'FROM events',
    whereClause,
    'ORDER BY global_position ASC',
  ].join('\n');

  return { sql, params };
}

/**
 * Compiles a QueryDefinition into a SELECT COALESCE(MAX(global_position), 0) query.
 * Used for version/concurrency checks. No ORDER BY.
 */
export function compileVersionCheckQuery(query: QueryDefinition): CompiledQuery {
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
 * Compiles a QueryDefinition into a keyset-paginated SELECT query.
 * Appends AND global_position > $N LIMIT $M to the WHERE clause.
 *
 * @param paramOffset - number of parameters that precede this query in the caller's param list.
 *   When 0 (default), params are numbered $1, $2, etc.
 *   When 2, params start at $3, $4, etc. (for embedding in a larger query).
 */
export function compileStreamQuery(
  query: QueryDefinition,
  afterPosition: bigint,
  batchSize: number,
  paramOffset: number = 0,
): CompiledQuery {
  const params: unknown[] = [];
  const counter = { n: paramOffset };
  const whereClause = compileWhereClause(query, params, counter);

  params.push(afterPosition);
  counter.n += 1;
  const positionRef = `$${counter.n}`;

  params.push(batchSize);
  counter.n += 1;
  const limitRef = `$${counter.n}`;

  const sql = [
    'SELECT global_position, event_id, type, payload, metadata, occurred_at',
    'FROM events',
    `${whereClause} AND global_position > ${positionRef}`,
    'ORDER BY global_position ASC',
    `LIMIT ${limitRef}`,
  ].join('\n');

  return { sql, params };
}

/**
 * Produces a stable canonical string representation of a QueryDefinition.
 * Clauses are sorted alphabetically by type. Used for advisory lock key derivation.
 */
export function compileCanonicalKey(query: QueryDefinition): string {
  function canonicalFilter(node: FilterNode | null): unknown {
    if (node === null) return null;
    if (node.kind === 'attr') {
      return { kind: 'attr', key: node.key, value: node.value };
    }
    return { kind: node.kind, filters: node.filters.map(canonicalFilter) };
  }

  const sorted = [...query._clauses].sort((a, b) => a.type.localeCompare(b.type));
  const canonical = sorted.map((clause) => ({
    type: clause.type,
    filter: canonicalFilter(clause.filter),
  }));

  return JSON.stringify(canonical);
}
