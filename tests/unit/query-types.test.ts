import { describe, it, expect } from 'vitest';
import type { FilterNode, Clause, QueryDefinition } from '../../src/query/types.js';

describe('FilterNode type', () => {
  it('attr node is valid', () => {
    const node: FilterNode = { kind: 'attr', key: 'customerId', value: 'c1' };
    expect(node.kind).toBe('attr');
  });

  it('and node accepts nested FilterNode array', () => {
    const child: FilterNode = { kind: 'attr', key: 'a', value: 1 };
    const node: FilterNode = { kind: 'and', filters: [child, child] };
    expect(node.kind).toBe('and');
  });

  it('or node accepts nested FilterNode array', () => {
    const child: FilterNode = { kind: 'attr', key: 'status', value: 'active' };
    const node: FilterNode = { kind: 'or', filters: [child] };
    expect(node.kind).toBe('or');
  });

  it('and node with zero filters is valid', () => {
    const node: FilterNode = { kind: 'and', filters: [] };
    expect(node.kind).toBe('and');
  });

  it('deeply nested FilterNode is valid', () => {
    const leaf: FilterNode = { kind: 'attr', key: 'k', value: 'v' };
    const inner: FilterNode = { kind: 'and', filters: [leaf] };
    const outer: FilterNode = { kind: 'or', filters: [inner, leaf] };
    expect(outer.kind).toBe('or');
  });

  it('value can be null', () => {
    const node: FilterNode = { kind: 'attr', key: 'k', value: null };
    expect(node.kind).toBe('attr');
  });

  it('value can be 0 (falsy)', () => {
    const node: FilterNode = { kind: 'attr', key: 'k', value: 0 };
    expect(node.kind).toBe('attr');
  });

  it('value can be a nested object', () => {
    const node: FilterNode = { kind: 'attr', key: 'k', value: { nested: true } };
    expect(node.kind).toBe('attr');
  });
});

describe('Clause type', () => {
  it('clause with null filter is valid', () => {
    const clause: Clause = { type: 'OrderCreated', filter: null };
    expect(clause.filter).toBeNull();
  });

  it('clause with FilterNode filter is valid', () => {
    const filter: FilterNode = { kind: 'attr', key: 'id', value: '1' };
    const clause: Clause = { type: 'OrderCreated', filter };
    expect(clause.filter).not.toBeNull();
  });

  it('clause type can be empty string', () => {
    const clause: Clause = { type: '', filter: null };
    expect(clause.type).toBe('');
  });
});

describe('QueryDefinition type', () => {
  it('QueryDefinition with empty clauses is valid', () => {
    const qd: QueryDefinition = { _clauses: [] };
    expect(qd._clauses).toHaveLength(0);
  });

  it('QueryDefinition with multiple clauses is valid', () => {
    const clauses: Clause[] = [
      { type: 'A', filter: null },
      { type: 'B', filter: { kind: 'attr', key: 'k', value: 'v' } },
    ];
    const qd: QueryDefinition = { _clauses: clauses };
    expect(qd._clauses).toHaveLength(2);
  });

  it('_clauses is readonly — mutation attempt fails at runtime via freeze', () => {
    const qd: QueryDefinition = Object.freeze({ _clauses: Object.freeze([]) });
    expect(() => {
      // @ts-expect-error — intentional: testing readonly enforcement
      qd._clauses = [];
    }).toThrow();
  });
});
