export type FilterNode =
  | { kind: 'attr'; key: string; value: unknown }
  | { kind: 'and';  filters: FilterNode[] }
  | { kind: 'or';   filters: FilterNode[] };

export interface Clause {
  type: string;
  filter: FilterNode | null;
}

/**
 * Opaque query value passed to load() and append().
 * Built exclusively via the query DSL — do not construct directly.
 */
export interface QueryDefinition {
  readonly _clauses: readonly Clause[];
}
