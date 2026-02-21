import { describe, it, expect } from 'vitest';
import { query } from '../../src/query/query-object.js';
import { ClauseBuilder } from '../../src/query/builder.js';
import type { QueryDefinition } from '../../src/query/types.js';

function attr(key: string, value: unknown) {
  return { kind: 'attr' as const, key, value };
}

describe('Query Builder', () => {

  // ---------------------------------------------------------------------------
  // Basic construction
  // ---------------------------------------------------------------------------
  describe('basic construction', () => {
    it('query.eventsOfType creates a single clause with the given type and null filter', () => {
      const qd = query.eventsOfType('OrderCreated');
      expect(qd._clauses).toHaveLength(1);
      expect(qd._clauses[0]!.type).toBe('OrderCreated');
      expect(qd._clauses[0]!.filter).toBeNull();
    });

    it('query.allEventsOfType produces an identical result to eventsOfType', () => {
      const a = query.eventsOfType('OrderCreated');
      const b = query.allEventsOfType('OrderCreated');
      expect(b._clauses).toHaveLength(1);
      expect(b._clauses[0]!.type).toBe('OrderCreated');
      expect(b._clauses[0]!.filter).toBeNull();
      expect(b._clauses).toEqual(a._clauses);
    });

    it('both are valid QueryDefinition (assignable to interface)', () => {
      const _a: QueryDefinition = query.eventsOfType('OrderCreated');
      const _b: QueryDefinition = query.allEventsOfType('OrderShipped');
      expect(_a).toBeDefined();
      expect(_b).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Property getters (not method calls)
  // ---------------------------------------------------------------------------
  describe('property getters', () => {
    it('.where is an object (property getter, not a method)', () => {
      expect(typeof query.eventsOfType('X').where).toBe('object');
    });

    it('.and is an object (property getter, not a method)', () => {
      expect(typeof query.eventsOfType('X').and).toBe('object');
    });

    it('.or is an object (property getter, not a method)', () => {
      expect(typeof query.eventsOfType('X').or).toBe('object');
    });
  });

  // ---------------------------------------------------------------------------
  // Simple where filter
  // ---------------------------------------------------------------------------
  describe('simple where filter', () => {
    it('.where.key().equals() sets an attr filter on the last clause', () => {
      const qd = query.eventsOfType('OrderCreated').where.key('customerId').equals('c1');
      const filter = qd._clauses[qd._clauses.length - 1]!.filter;
      expect(filter).toEqual(attr('customerId', 'c1'));
    });
  });

  // ---------------------------------------------------------------------------
  // AND accumulation
  // ---------------------------------------------------------------------------
  describe('AND accumulation', () => {
    it('two .and calls produce a flat AND node with two children', () => {
      const qd = query
        .eventsOfType('OrderCreated')
        .where.key('a').equals(1)
        .and.key('b').equals(2);
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual({ kind: 'and', filters: [attr('a', 1), attr('b', 2)] });
    });

    it('three .and calls produce a flat AND node with three children (not nested)', () => {
      const qd = query
        .eventsOfType('OrderCreated')
        .where.key('a').equals(1)
        .and.key('b').equals(2)
        .and.key('c').equals(3);
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual({
        kind: 'and',
        filters: [attr('a', 1), attr('b', 2), attr('c', 3)],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // OR accumulation
  // ---------------------------------------------------------------------------
  describe('OR accumulation', () => {
    it('two .or calls produce a flat OR node with two children', () => {
      const qd = query
        .eventsOfType('OrderCreated')
        .where.key('status').equals('pending')
        .or.key('status').equals('active');
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual({
        kind: 'or',
        filters: [attr('status', 'pending'), attr('status', 'active')],
      });
    });

    it('three .or calls produce a flat OR node with three children', () => {
      const qd = query
        .eventsOfType('OrderCreated')
        .where.key('status').equals('pending')
        .or.key('status').equals('active')
        .or.key('status').equals('closed');
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual({
        kind: 'or',
        filters: [
          attr('status', 'pending'),
          attr('status', 'active'),
          attr('status', 'closed'),
        ],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-type (multiple clauses)
  // ---------------------------------------------------------------------------
  describe('multi-type queries (multiple clauses)', () => {
    it('chaining two eventsOfType calls creates two clauses', () => {
      const qd = query.eventsOfType('A').eventsOfType('B');
      expect(qd._clauses).toHaveLength(2);
    });

    it('first clause has type A, second has type B', () => {
      const qd = query.eventsOfType('A').eventsOfType('B');
      expect(qd._clauses[0]!.type).toBe('A');
      expect(qd._clauses[1]!.type).toBe('B');
    });

    it('filter on first clause is not affected by second eventsOfType call', () => {
      const qd = query
        .eventsOfType('A')
        .where.key('x').equals(1)
        .eventsOfType('B');
      expect(qd._clauses[0]!.filter).toEqual(attr('x', 1));
      expect(qd._clauses[1]!.filter).toBeNull();
    });

    it('filters on different clauses are independent', () => {
      const qd = query
        .eventsOfType('A')
        .where.key('x').equals(1)
        .eventsOfType('B')
        .where.key('y').equals(2);
      expect(qd._clauses[0]!.filter).toEqual(attr('x', 1));
      expect(qd._clauses[1]!.filter).toEqual(attr('y', 2));
    });
  });

  // ---------------------------------------------------------------------------
  // Immutability
  // ---------------------------------------------------------------------------
  describe('immutability', () => {
    it('adding a second filter does not mutate the intermediate ClauseBuilder', () => {
      const base = query.eventsOfType('OrderCreated').where.key('k').equals('v');
      const extended = base.and.key('k2').equals('v2');

      expect(base._clauses[0]!.filter).toEqual(attr('k', 'v'));
      expect(extended._clauses[0]!.filter).toEqual({
        kind: 'and',
        filters: [attr('k', 'v'), attr('k2', 'v2')],
      });
    });

    it('both references can be used independently as QueryDefinition', () => {
      const base = query.eventsOfType('OrderCreated').where.key('k').equals('v');
      const branch1 = base.and.key('k2').equals('v2');
      const branch2 = base.or.key('k3').equals('v3');

      expect(base._clauses[0]!.filter).toEqual(attr('k', 'v'));

      expect(branch1._clauses[0]!.filter).toEqual({
        kind: 'and',
        filters: [attr('k', 'v'), attr('k2', 'v2')],
      });

      expect(branch2._clauses[0]!.filter).toEqual({
        kind: 'or',
        filters: [attr('k', 'v'), attr('k3', 'v3')],
      });

      const _b1: QueryDefinition = branch1;
      const _b2: QueryDefinition = branch2;
      expect(_b1).toBeDefined();
      expect(_b2).toBeDefined();
    });

    it('each ClauseBuilder instance is a distinct object', () => {
      const a = query.eventsOfType('X');
      const b = a.where.key('k').equals('v');
      expect(a).not.toBe(b);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('empty string type does not throw', () => {
      expect(() => query.eventsOfType('')).not.toThrow();
      expect(query.eventsOfType('')._clauses[0]!.type).toBe('');
    });

    it('equals(null) stores null as the value', () => {
      const qd = query.eventsOfType('X').where.key('k').equals(null);
      expect(qd._clauses[0]!.filter).toEqual(attr('k', null));
    });

    it('equals(0) stores 0 (not coerced to falsy)', () => {
      const qd = query.eventsOfType('X').where.key('count').equals(0);
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual(attr('count', 0));
      if (filter && filter.kind === 'attr') {
        expect(filter.value).toBe(0);
      }
    });

    it('equals({ nested: true }) stores the object as-is', () => {
      const obj = { nested: true };
      const qd = query.eventsOfType('X').where.key('meta').equals(obj);
      const filter = qd._clauses[0]!.filter;
      expect(filter).toEqual(attr('meta', { nested: true }));
      if (filter && filter.kind === 'attr') {
        expect(filter.value).toBe(obj);
      }
    });

    it('.and without prior .where on a clause with no filter is treated as first filter', () => {
      const qd = query.eventsOfType('X').and.key('k').equals('v');
      expect(qd._clauses[0]!.filter).toEqual(attr('k', 'v'));
    });
  });

  // ---------------------------------------------------------------------------
  // ClauseBuilder methods
  // ---------------------------------------------------------------------------
  describe('ClauseBuilder.eventsOfType and allEventsOfType', () => {
    it('ClauseBuilder.eventsOfType appends a new clause', () => {
      const builder = new ClauseBuilder([{ type: 'A', filter: null }]);
      const extended = builder.eventsOfType('B');
      expect(extended._clauses).toHaveLength(2);
      expect(extended._clauses[1]!).toEqual({ type: 'B', filter: null });
    });

    it('ClauseBuilder.allEventsOfType is an alias for eventsOfType', () => {
      const builder = new ClauseBuilder([{ type: 'A', filter: null }]);
      const via1 = builder.eventsOfType('B');
      const via2 = builder.allEventsOfType('B');
      expect(via1._clauses).toEqual(via2._clauses);
    });
  });
});
