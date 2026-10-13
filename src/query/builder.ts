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

/**
 * Combines multiple queries into a single query by merging all items.
 * Useful for command handlers that need to load and lock multiple streams.
 * 
 * @example
 * const combined = combineQueries(
 *   studentStream(studentId),
 *   courseStream(courseId),
 *   enrollmentStream(studentId, courseId)
 * );
 * const { events, position } = await store.load(combined);
 * // All events from all three streams in one result
 * // Use the single position for the append condition
 * await store.append(newEvents, {
 *   failIfEventsMatch: combined,
 *   after: position,
 * });
 */
export function combineQueries(...queries: Query[]): Query {
  if (queries.length === 0) {
    throw new Error('combineQueries requires at least one query');
  }
  const allItems = queries.flatMap(q => q.items);
  return { items: allItems };
}
