/**
 * A single item in a Query.
 * An event matches this item when:
 * - The event's type is in `types` (or `types` is empty, meaning any type)
 * - The event has ALL of the tags listed in `tags`
 */
export interface QueryItem {
  /**
   * Event types to match. Empty array means any type.
   */
  readonly types?: readonly string[];
  
  /**
   * Tags that the event must have (AND constraint).
   */
  readonly tags?: readonly string[];
}

/**
 * A Query is a list of QueryItems, combined with OR.
 * An event matches the query if it matches ANY of the items.
 */
export interface Query {
  readonly items: readonly QueryItem[];
}
