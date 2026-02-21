import { ClauseBuilder } from './builder.js';

/**
 * Entry point for the query DSL.
 *
 * @example
 * query.eventsOfType('OrderCreated')
 *   .where.key('customerId').equals('c1')
 *   .and.key('region').equals('EU')
 *   .eventsOfType('OrderShipped')
 *     .where.key('orderId').equals('o1')
 */
export const query = {
  eventsOfType(type: string): ClauseBuilder {
    return new ClauseBuilder([{ type, filter: null }]);
  },
  /** Alias for eventsOfType — delegates to avoid duplication. */
  allEventsOfType(type: string): ClauseBuilder {
    return query.eventsOfType(type);
  },
};
