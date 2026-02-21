import type { Clause, FilterNode, QueryDefinition } from './types.js';

/**
 * Applies a new FilterNode to the last clause in the clauses array,
 * using the specified combinator to determine how it combines with
 * any existing filter on that clause.
 */
function _applyFilter(
  clauses: readonly Clause[],
  combinator: 'where' | 'and' | 'or',
  newNode: FilterNode,
): ClauseBuilder {
  if (clauses.length === 0) {
    throw new Error('_applyFilter called with empty clauses array');
  }
  // Safe: length guard above ensures the element exists; cast needed for noUncheckedIndexedAccess
  const last = clauses[clauses.length - 1] as Clause;
  const rest = clauses.slice(0, -1);

  const replaceFilter = (f: FilterNode): Clause => ({ type: last.type, filter: f });

  if (combinator === 'where') {
    return new ClauseBuilder([...rest, replaceFilter(newNode)]);
  }

  if (combinator === 'and') {
    if (last.filter === null) {
      // No existing filter — treat as first filter (same as where)
      return new ClauseBuilder([...rest, replaceFilter(newNode)]);
    }
    const existing = last.filter;
    if (existing.kind === 'and') {
      // Flat accumulation: append to existing and-node
      const merged: FilterNode = { kind: 'and', filters: [...existing.filters, newNode] };
      return new ClauseBuilder([...rest, replaceFilter(merged)]);
    }
    // Wrap both into a new and-node
    const merged: FilterNode = { kind: 'and', filters: [existing, newNode] };
    return new ClauseBuilder([...rest, replaceFilter(merged)]);
  }

  // combinator === 'or'
  if (last.filter === null) {
    // No existing filter — treat as first filter (same as where)
    return new ClauseBuilder([...rest, replaceFilter(newNode)]);
  }
  const existing = last.filter;
  if (existing.kind === 'or') {
    // Flat accumulation: append to existing or-node
    const merged: FilterNode = { kind: 'or', filters: [...existing.filters, newNode] };
    return new ClauseBuilder([...rest, replaceFilter(merged)]);
  }
  // Wrap both into a new or-node
  const merged: FilterNode = { kind: 'or', filters: [existing, newNode] };
  return new ClauseBuilder([...rest, replaceFilter(merged)]);
}

/**
 * Fluent immutable query builder. Implements QueryDefinition so it can
 * be passed directly to load() and append(). Every operation returns a
 * new ClauseBuilder — existing instances are never mutated.
 */
export class ClauseBuilder implements QueryDefinition {
  constructor(readonly _clauses: readonly Clause[]) {}

  /** Start a new filter expression on the last clause. */
  get where(): KeySelector {
    return new KeySelector(this._clauses, 'where');
  }

  /** Combine with the existing filter using AND. */
  get and(): KeySelector {
    return new KeySelector(this._clauses, 'and');
  }

  /** Combine with the existing filter using OR. */
  get or(): KeySelector {
    return new KeySelector(this._clauses, 'or');
  }

  /** Append a new clause for the given event type. */
  eventsOfType(type: string): ClauseBuilder {
    return new ClauseBuilder([...this._clauses, { type, filter: null }]);
  }

  /** Alias for eventsOfType — matches all events of the given type. */
  allEventsOfType(type: string): ClauseBuilder {
    return this.eventsOfType(type);
  }
}

/**
 * Intermediate builder step — holds the combinator and awaits a key name.
 */
export class KeySelector {
  constructor(
    private readonly _clauses: readonly Clause[],
    private readonly _combinator: 'where' | 'and' | 'or',
  ) {}

  /** Select the metadata/payload attribute key to match against. */
  key(k: string): ValueSetter {
    return new ValueSetter(this._clauses, this._combinator, k);
  }
}

/**
 * Intermediate builder step — holds the key and awaits a value to match.
 */
export class ValueSetter {
  constructor(
    private readonly _clauses: readonly Clause[],
    private readonly _combinator: 'where' | 'and' | 'or',
    private readonly _key: string,
  ) {}

  /** Complete the filter expression with the value to match. */
  equals(value: unknown): ClauseBuilder {
    const newNode: FilterNode = { kind: 'attr', key: this._key, value };
    return _applyFilter(this._clauses, this._combinator, newNode);
  }
}
