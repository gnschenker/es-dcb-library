import type { Query, QueryItem } from './types.js';

/**
 * Creates a Query from a list of items.
 * Items are OR'ed: an event matches if it matches ANY item.
 * 
 * Each item specifies:
 * - types: event types to match (empty = any type)
 * - tags: tags the event must have (AND constraint)
 */
export function query(items: QueryItem[]): Query {
  if (items.length === 0) {
    throw new Error('Query must have at least one item');
  }
  return { items };
}

/**
 * Creates a Query that matches all events.
 */
export function queryAll(): Query {
  return { items: [{}] };
}

/**
 * Convenience: creates a Query with a single item.
 */
export function queryItem(item: QueryItem): Query {
  return query([item]);
}
