# Implementation Plan: es-dcb-library

> **Stack:** TypeScript · Node.js · `pg` (node-postgres) · `tsup` · `vitest` · `testcontainers`
>
> **Design references:** [`plan.md`](./plan.md) · [`architecture-review.md`](./architecture-review.md)
>
> **Status values:** `pending` · `in implementation` · `done`
>
> **Concurrency:** Tasks with no overlapping dependencies may be claimed by separate agents simultaneously.
> Set **Claimed by** to your agent ID when starting a task. Clear it if you abandon the task.

---

## Git Flow (per task)

Every task follows this sequence. Do not skip steps.

### Before starting
```bash
git checkout main && git pull
git checkout -b task/T-XX-short-description
```
Update the task row in the **Task Index** table: **Status** → `in implementation`, **Claimed by** → your agent ID.

### During implementation
Write source files and test files exactly as specified in the task section below. Commit in logical increments on the branch.

### After implementation — verify locally
```bash
npm run typecheck                # must exit 0
npm run test:unit                # must exit 0
npm run test:integration         # must exit 0 (tasks that have integration tests)
npm run build                    # must exit 0 (T-13 and any task that changes the public API)
```
All checks must be green before opening a PR.

### Push and open a PR
```bash
git push -u origin task/T-XX-short-description

gh pr create \
  --title "feat: T-XX <description>" \
  --body "Implements task T-XX from .docs/implementation-plan.md" \
  --base main
```

Spawn a **reviewer agent** (subagent_type: `Plan`) and provide the PR number and the task specification from this document. The reviewer reads the diff with `gh pr diff <number>` and posts a structured review:
```bash
gh pr review <number> --comment --body "..."
```
Issues are categorised: **Critical** / **Medium** (must fix before merge) · **Minor** (implementing agent decides).

### Address issues and push fixes
Fix all Critical and Medium issues on the same branch, re-run all checks, then:
```bash
git push
```
The reviewer posts a follow-up comment via `gh pr review`. Repeat until no Critical or Medium issues remain.

### Final approval and merge
```bash
# Reviewer approves
gh pr review <number> --approve --body "Approved."

# Merge (normal merge commit — not squash, not rebase)
gh pr merge <number> --merge --delete-branch
```

### After merge
```bash
git checkout main && git pull
```
Update the task row: **Status** → `done`, clear **Claimed by**.

---

## Dependency Graph

```
T-01  (Scaffolding)
  ├── T-02  (Query Types)
  │     └── T-03  (Query Builder)
  │           └── T-04  (Query Compiler)
  ├── T-05  (Core Types & Errors)
  │     └── T-07  (Row Mapper)
  ├── T-06  (Database Schema)
  └── T-08  (Integration Test Infrastructure)

All of T-04, T-05, T-06, T-07, T-08 must be done before:
  └── T-09  (Event Store — load)
        ├── T-10  (Event Store — append, no concurrency)
        │     └── T-11  (Event Store — append + advisory locks)
        └── T-12  (Event Store — stream)

T-09 + T-10 + T-11 + T-12 must be done before:
  └── T-13  (Public API barrel + build verification)
```

**Parallelisable groups (after T-01 is done):**
- Group A: T-02, T-05, T-06, T-08 — no mutual dependencies
- Group B (after T-02): T-03
- Group C (after T-03): T-04
- Group D (after T-05): T-07
- Group E (after all of T-04/T-05/T-06/T-07/T-08): T-09
- Group F (after T-09): T-10 and T-12 in parallel
- Group G (after T-10): T-11

---

## Task Index

| ID | Title | Status | Claimed by |
|----|-------|--------|------------|
| T-01 | Project Scaffolding | `done` | — |
| T-02 | Query Internal Types | `done` | — |
| T-03 | Query Builder | `done` | — |
| T-04 | Query Compiler | `done` | — |
| T-05 | Core Types & Errors | `done` | — |
| T-06 | Database Schema DDL | `done` | — |
| T-07 | Row Mapper | `done` | — |
| T-08 | Integration Test Infrastructure | `done` | — |
| T-09 | Event Store — `load()` | `done` | — |
| T-10 | Event Store — `append()` (no concurrency) | `done` | — |
| T-11 | Event Store — `append()` with advisory locks | `done` | — |
| T-12 | Event Store — `stream()` | `done` | — |
| T-13 | Public API Barrel + Build Verification | `done` | — |

---

## Tasks

---

### T-01 — Project Scaffolding

**Status:** `done`
**Claimed by:** —
**Depends on:** nothing
**Blocks:** all other tasks

#### Goal
Create the complete project skeleton: all config files, directory structure, and toolchain wiring. No source code yet — only the infrastructure that every subsequent task builds on.

#### Files to create

```
package.json
tsconfig.json
tsconfig.build.json
tsup.config.ts
vitest.config.ts
src/.gitkeep
tests/unit/.gitkeep
tests/integration/.gitkeep
```

#### Specification

**`package.json`**
- `"type": "module"` (ESM-first)
- `"main"`: `./dist/index.cjs`
- `"module"`: `./dist/index.js`
- `"types"`: `./dist/index.d.ts`
- `exports` field with `import` and `require` conditions (avoids dual-package hazard)
- Scripts: `build`, `typecheck`, `test`, `test:unit`, `test:integration`, `test:watch`
- `engines`: `{ "node": ">=18" }`
- Dependencies: `pg@^8.13.3`
- DevDependencies: `@types/pg@^8.11.10`, `@types/node@^22.13.4`, `typescript@^5.7.3`, `tsup@^8.3.6`, `vitest@^3.0.5`, `testcontainers@^10.24.0`

**`tsconfig.json`**
- `target`: `ES2022`
- `module`: `NodeNext`, `moduleResolution`: `NodeNext`
- `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- `include`: `["src/**/*", "tests/**/*"]`

**`tsconfig.build.json`**
- Extends `tsconfig.json`
- `include`: `["src/**/*"]` only (excludes tests from the published build)

**`tsup.config.ts`**
- `entry`: `['src/index.ts']`
- `format`: `['esm', 'cjs']`
- `dts: true`, `splitting: false`, `sourcemap: true`, `clean: true`
- `tsconfig: './tsconfig.build.json'`

**`vitest.config.ts`**
- Unit test pattern: `tests/unit/**/*.test.ts`
- Integration test pattern: `tests/integration/**/*.test.ts`
- `globalSetup` pointing to `tests/integration/setup.ts` (used only when running integration tests)
- `testTimeout`: 30000 for integration (containers can be slow), 5000 for unit

#### Acceptance criteria
- [ ] `npm install` completes without errors
- [ ] `npm run typecheck` passes (no source files yet — zero errors expected)
- [ ] `npm run build` fails gracefully (no entry point yet — acceptable at this stage, OR create a stub `src/index.ts` with a single empty export)
- [ ] `npm run test:unit` exits 0 (no tests yet)
- [ ] Directory structure matches the file tree in the plan

---

### T-02 — Query Internal Types

**Status:** `pending`
**Claimed by:** —
**Depends on:** T-01
**Blocks:** T-03, T-04

#### Goal
Define the internal TypeScript types that represent a compiled query in-memory. These are pure type definitions with no runtime logic.

#### Files to create
- `src/query/types.ts`

#### Specification

```typescript
export type FilterNode =
  | { kind: 'attr'; key: string; value: unknown }
  | { kind: 'and';  filters: FilterNode[] }
  | { kind: 'or';   filters: FilterNode[] };

export interface Clause {
  type: string;
  filter: FilterNode | null;
}

export interface QueryDefinition {
  readonly _clauses: readonly Clause[];
}
```

`QueryDefinition` is intentionally opaque — callers receive it from the builder and pass it to the store without inspecting internals.

#### Tests
`tests/unit/query-types.test.ts`

Since these are pure type definitions, tests are type-level (compile-time) assertions using TypeScript's `satisfies` and assignability checks:

- `FilterNode` with `kind: 'attr'` is assignable to `FilterNode`
- `FilterNode` with `kind: 'and'` accepts nested `FilterNode[]`
- `FilterNode` with `kind: 'or'` accepts nested `FilterNode[]`
- `Clause` with `filter: null` is valid
- `QueryDefinition._clauses` is `readonly`
- Assigning to `_clauses` is a type error

All assertions must be validated by `npm run typecheck` with `strict: true`.

#### Acceptance criteria
- [ ] File exports `FilterNode`, `Clause`, `QueryDefinition`
- [ ] `npm run typecheck` passes with zero errors
- [ ] Type-level tests pass

---

### T-03 — Query Builder

**Status:** `done`
**Claimed by:** —
**Depends on:** T-02
**Blocks:** T-04

#### Goal
Implement the fluent immutable query builder DSL. The result of the chain is a valid `QueryDefinition` at every point.

#### Files to create
- `src/query/builder.ts`
- `src/query/query-object.ts`

#### Specification

**`builder.ts` — three classes:**

`ClauseBuilder` (implements `QueryDefinition`):
- Constructor takes `readonly _clauses: readonly Clause[]`
- `get where(): KeySelector` — property getter, returns `new KeySelector(this._clauses, 'where')`
- `get and(): KeySelector` — property getter, returns `new KeySelector(this._clauses, 'and')`
- `get or(): KeySelector` — property getter, returns `new KeySelector(this._clauses, 'or')`
- `eventsOfType(type: string): ClauseBuilder` — appends a new clause with no filter
- `allEventsOfType(type: string): ClauseBuilder` — alias for `eventsOfType`

`KeySelector`:
- Constructor takes `clauses: readonly Clause[]` and `combinator: 'where' | 'and' | 'or'`
- `key(k: string): ValueSetter` — returns `new ValueSetter(this._clauses, this._combinator, k)`

`ValueSetter`:
- Constructor takes `clauses`, `combinator`, `key`
- `equals(value: unknown): ClauseBuilder` — creates the new filter node, applies it, returns new `ClauseBuilder`

**Filter merging in `_applyFilter(clauses, combinator, newNode)`:**
- `'where'`: replace filter on the last clause → `new ClauseBuilder([...clauses.slice(0,-1), { ...last, filter: newNode }])`
- `'and'`: if last clause has no filter → treat as `'where'`; if has `{ kind: 'and' }` → append to its filters; otherwise → wrap both into `{ kind: 'and', filters: [existing, newNode] }`
- `'or'`: same pattern but with `{ kind: 'or' }`

**Immutability invariant:** `ClauseBuilder` instances are never mutated. Every operation returns a new instance. Callers can hold references to intermediate states and branch from them.

**`query-object.ts`:**
```typescript
export const query = {
  eventsOfType(type: string): ClauseBuilder {
    return new ClauseBuilder([{ type, filter: null }]);
  },
  allEventsOfType(type: string): ClauseBuilder {
    return new ClauseBuilder([{ type, filter: null }]);
  },
};
```

#### Tests
`tests/unit/query-builder.test.ts`

**Basic construction:**
- `query.eventsOfType('OrderCreated')._clauses` has one clause, `type='OrderCreated'`, `filter=null`
- `query.allEventsOfType('OrderCreated')._clauses` is identical to `eventsOfType`
- Both are valid `QueryDefinition` (assignable to the interface)

**Property getters (not method calls):**
- `typeof builder.where` is `'object'` (not `'function'`) — accessing `.where` returns a `KeySelector`, not a function
- `typeof builder.and` is `'object'`
- `typeof builder.or` is `'object'`

**Simple `where` filter:**
- `.where.key('customerId').equals('c1')` → last clause has `filter: { kind: 'attr', key: 'customerId', value: 'c1' }`

**AND accumulation:**
- `.where.key('a').equals(1).and.key('b').equals(2)` → `filter: { kind: 'and', filters: [attr(a,1), attr(b,2)] }`
- Three `.and` calls → `filter: { kind: 'and', filters: [attr(a,1), attr(b,2), attr(c,3)] }` (flat, not nested)

**OR accumulation:**
- `.where.key('status').equals('pending').or.key('status').equals('active')` → `filter: { kind: 'or', filters: [attr, attr] }`
- Three `.or` calls → flat OR node with 3 children (not `or(or(a,b),c)`)

**Multi-type (multiple clauses):**
- `.eventsOfType('A').eventsOfType('B')._clauses.length === 2`
- First clause: type='A', second clause: type='B'
- Filters on first clause are not affected by second `.eventsOfType`

**Immutability:**
- Hold a reference to an intermediate `ClauseBuilder` (after `.where.key('k').equals('v')`)
- Call `.and.key('k2').equals('v2')` on it
- The original intermediate reference still has only one filter (unmodified)
- Both references can be independently used as query definitions

**Edge cases:**
- Empty string type: `query.eventsOfType('')` — allowed, no error thrown
- `value` of `null` in `equals(null)` — stored as-is
- `value` of `0` (falsy) in `equals(0)` — stored correctly, not coerced to null/undefined
- `value` of a nested object in `equals({ nested: true })` — stored as-is
- Chaining `.and` without a prior `.where` on a clause with no filter → treated as first filter

#### Acceptance criteria
- [ ] All tests pass
- [ ] `npm run typecheck` passes with zero errors
- [ ] `ClauseBuilder` implements `QueryDefinition` (satisfies interface)

---

### T-04 — Query Compiler

**Status:** `done`
**Claimed by:** —
**Depends on:** T-03
**Blocks:** T-09

#### Goal
Compile a `QueryDefinition` into parameterized PostgreSQL SQL strings and parameter arrays. Also produce a canonical string key from a query (used for advisory lock hashing).

#### Files to create
- `src/query/compiler.ts`

#### Specification

**Exported functions:**

```typescript
export interface CompiledQuery {
  sql: string;
  params: unknown[];
}

// Full SELECT query, ordered by global_position ASC
export function compileLoadQuery(query: QueryDefinition): CompiledQuery

// SELECT COALESCE(MAX(global_position),0) — no ORDER BY
export function compileVersionCheckQuery(query: QueryDefinition): CompiledQuery

// SELECT with AND global_position > $N LIMIT $M appended to WHERE clause
export function compileStreamQuery(
  query: QueryDefinition,
  afterPosition: bigint,
  batchSize: number,
  paramOffset: number   // start numbering from this $N (default 1)
): CompiledQuery

// Stable sorted string for advisory lock key derivation
export function compileCanonicalKey(query: QueryDefinition): string
```

**FilterNode → SQL fragment:**
- `{ kind: 'attr', key, value }` → param slot `$N`, param value `JSON.stringify({ [key]: value })`, SQL: `payload @> $N::jsonb`
- `{ kind: 'and', filters }` → `(f1 AND f2 AND ...)` — each child compiled recursively
- `{ kind: 'or', filters }` → `(f1 OR f2 OR ...)` — each child compiled recursively

**Clause → SQL fragment:**
- No filter: `type = $N`
- With filter: `(type = $N AND <filterSQL>)`

**Multiple clauses:**
- One clause: `WHERE <clauseSQL>`
- Multiple clauses: `WHERE (<c1> OR <c2> OR ...)`

**Load query shape:**
```sql
SELECT global_position, event_id, type, payload, metadata, occurred_at
FROM events
WHERE <compiled>
ORDER BY global_position ASC
```

**Version check query shape:**
```sql
SELECT COALESCE(MAX(global_position), 0) AS max_pos
FROM events
WHERE <compiled>
```

**Stream query shape:**
```sql
SELECT global_position, event_id, type, payload, metadata, occurred_at
FROM events
WHERE <compiled> AND global_position > $N
ORDER BY global_position ASC
LIMIT $M
```

**`compileCanonicalKey` rules:**
- Clauses sorted by `type` alphabetically
- Within each clause, filters serialized as canonical JSON (keys sorted)
- Result is a stable string regardless of DSL construction order
- Two `QueryDefinition` objects that are logically equivalent (same types, same filters) produce the same key

#### Tests
`tests/unit/query-compiler.test.ts`

**Load query — no filter:**
- Input: `query.eventsOfType('OrderCreated')`
- Expected SQL: `SELECT global_position, event_id, type, payload, metadata, occurred_at FROM events WHERE type = $1 ORDER BY global_position ASC`
- Expected params: `['OrderCreated']`

**Load query — single attr filter:**
- Input: `query.eventsOfType('OrderCreated').where.key('customerId').equals('c1')`
- Expected params: `['OrderCreated', '{"customerId":"c1"}']`
- SQL contains: `WHERE (type = $1 AND payload @> $2::jsonb)`

**Load query — AND filter:**
- Input: `.where.key('a').equals(1).and.key('b').equals(2)`
- SQL contains: `payload @> $2::jsonb AND payload @> $3::jsonb`
- params: `['type', '{"a":1}', '{"b":2}']`

**Load query — OR filter:**
- Input: `.where.key('status').equals('pending').or.key('status').equals('active')`
- SQL contains: `payload @> $2::jsonb OR payload @> $3::jsonb`
- params: `['type', '{"status":"pending"}', '{"status":"active"}']`

**Load query — multi-type (two clauses):**
- Two clauses produce: `WHERE ((type = $1 AND payload @> $2::jsonb) OR (type = $3 AND payload @> $4::jsonb))`
- Params: 4 entries in correct order

**Load query — multi-type, second clause has no filter:**
- `query.eventsOfType('A').where.key('k').equals('v').eventsOfType('B')`
- First clause: `(type = $1 AND payload @> $2::jsonb)`
- Second clause: `type = $3` (no filter parens)

**Version check query:**
- Starts with `SELECT COALESCE(MAX(global_position), 0) AS max_pos FROM events WHERE`
- Does NOT contain `ORDER BY`
- Does NOT contain `SELECT global_position, event_id`

**Stream query:**
- Contains `AND global_position > $N` where N = (number of filter params + 1)
- Contains `LIMIT $M` where M = N + 1
- Contains `ORDER BY global_position ASC`

**Canonical key:**
- `compileCanonicalKey(q1) === compileCanonicalKey(q2)` when q1 and q2 are logically equivalent
- Different type name → different key
- Different filter value → different key
- Stable across multiple calls (no randomness)
- Multi-clause queries: clauses sorted alphabetically by type

**Parameter numbering correctness:**
- `$N` values are sequential starting at `$1`
- No gaps, no duplicates in parameter list
- `paramOffset` shifts starting number for stream query (for appending to existing param list)

**Value serialization:**
- `equals(null)` → `'{"key":null}'`
- `equals(0)` → `'{"key":0}'`
- `equals(false)` → `'{"key":false}'`
- `equals({ nested: true })` → `'{"key":{"nested":true}}'`

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] `npm run typecheck` passes

---

### T-05 — Core Types & Errors

**Status:** `done`
**Claimed by:** —
**Depends on:** T-01
**Blocks:** T-07, T-09

#### Goal
Define the public domain types (`NewEvent`, `StoredEvent`, `LoadResult`, `AppendOptions`, `StreamOptions`, `EventStore`) and the two public error classes (`ConcurrencyError`, `EventStoreError`).

#### Files to create
- `src/types.ts`
- `src/errors.ts`

#### Specification

**`src/types.ts`:**
```typescript
export interface NewEvent<P = Record<string, unknown>> {
  type: string;
  payload: P;
  metadata?: Record<string, unknown>;
}

export interface StoredEvent<P = Record<string, unknown>> {
  globalPosition: bigint;
  eventId: string;       // UUID
  type: string;
  payload: P;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

export interface LoadResult {
  events: StoredEvent[];
  version: bigint;       // MAX(global_position), or 0n if no events matched
}

export interface AppendOptions {
  query: QueryDefinition;
  expectedVersion: bigint;
  concurrencyQuery?: QueryDefinition;
}

export interface StreamOptions {
  batchSize?: number;       // default: 100
  afterPosition?: bigint;   // default: 0n
}

export interface EventStore {
  load(query: QueryDefinition): Promise<LoadResult>;
  append(events: NewEvent | NewEvent[], options?: AppendOptions): Promise<StoredEvent[]>;
  stream(query: QueryDefinition, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
```

**`src/errors.ts`:**

```typescript
export class ConcurrencyError extends Error {
  readonly name = 'ConcurrencyError';
  constructor(
    readonly expectedVersion: bigint,
    readonly actualVersion: bigint,
    message?: string,
  ) { ... }
}

export class EventStoreError extends Error {
  readonly name = 'EventStoreError';
  constructor(message: string, readonly cause?: unknown) { ... }
}
```

#### Tests
`tests/unit/errors.test.ts`

**`ConcurrencyError`:**
- `new ConcurrencyError(1n, 2n)` — no error thrown during construction
- `.name === 'ConcurrencyError'`
- `.expectedVersion === 1n` (BigInt)
- `.actualVersion === 2n` (BigInt)
- `instanceof ConcurrencyError` is `true`
- `instanceof Error` is `true`
- `.message` is a non-empty string (auto-generated if not provided)
- Custom message: `new ConcurrencyError(1n, 2n, 'my message').message === 'my message'`
- Stack trace is present (`.stack` is defined)

**`EventStoreError`:**
- `new EventStoreError('something went wrong')` — no error thrown
- `.name === 'EventStoreError'`
- `instanceof EventStoreError` is `true`
- `instanceof Error` is `true`
- `.cause` is `undefined` when not provided
- `.cause` holds the provided cause object when provided
- `new EventStoreError('msg', new Error('root'))` — `.cause` is the root error

**Type-level tests (typecheck):**
- `ConcurrencyError` is assignable to `Error`
- `EventStoreError` is assignable to `Error`
- `StoredEvent.globalPosition` is `bigint` (not `number`)
- `LoadResult.version` is `bigint`
- `AppendOptions.expectedVersion` is `bigint`
- `StoredEvent.metadata` accepts both `Record<string, unknown>` and `null`

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] `npm run typecheck` passes

---

### T-06 — Database Schema DDL

**Status:** `done`
**Claimed by:** —
**Depends on:** T-01
**Blocks:** T-09

#### Goal
Define all SQL DDL as typed string constants. Also export a helper that applies the schema to a given database connection. The schema must be safe to run multiple times (idempotent).

#### Files to create
- `src/store/schema.ts`

#### Specification

Export a single async function:
```typescript
export async function applySchema(client: pg.ClientBase): Promise<void>
```

The function executes the following DDL in order:

```sql
CREATE TABLE IF NOT EXISTS events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  payload          JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_payload_gin
  ON events USING GIN (payload jsonb_path_ops);

ALTER INDEX IF EXISTS idx_events_payload_gin
  SET (fastupdate = on, gin_pending_list_limit = 65536);

CREATE INDEX IF NOT EXISTS idx_events_type_position
  ON events (type, global_position);

CREATE INDEX IF NOT EXISTS idx_events_occurred_at_brin
  ON events USING BRIN (occurred_at)
  WITH (pages_per_range = 128);

ALTER TABLE events SET (
  autovacuum_vacuum_scale_factor  = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay    = 2
);
```

Note: `idx_events_type` is intentionally absent (covered by `idx_events_type_position`).

Also export the DDL constants as named strings so tests can assert on their content without parsing SQL.

#### Tests
`tests/unit/schema.test.ts`

**DDL content assertions (unit, no DB):**
- DDL strings contain `CREATE TABLE IF NOT EXISTS events`
- `global_position BIGSERIAL PRIMARY KEY` is present
- `event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE` is present
- `payload JSONB NOT NULL` is present
- `metadata JSONB` is present (nullable — no `NOT NULL`)
- `occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` is present
- `idx_events_payload_gin` uses `GIN` and `jsonb_path_ops`
- `idx_events_type_position` covers `(type, global_position)`
- `idx_events_occurred_at_brin` uses `BRIN`
- `idx_events_type` is NOT present anywhere in the DDL (was intentionally dropped)
- `gin_pending_list_limit = 65536` is present
- `autovacuum_vacuum_scale_factor = 0.01` is present

`tests/integration/schema.test.ts`

**Idempotency (integration, real DB):**
- Run `applySchema` twice on the same database — no error thrown on second call
- After applying: `events` table exists in `information_schema.tables`
- After applying: `idx_events_payload_gin` index exists in `pg_indexes`
- After applying: `idx_events_type_position` index exists
- After applying: `idx_events_occurred_at_brin` index exists
- After applying: `idx_events_type` does NOT exist in `pg_indexes`

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] `npm run typecheck` passes

---

### T-07 — Row Mapper

**Status:** `done`
**Claimed by:** —
**Depends on:** T-05
**Blocks:** T-09

#### Goal
Map a raw `pg` result row (as returned by `pg.QueryResult.rows[N]`) to a typed `StoredEvent`.

#### Files to create
- `src/store/row-mapper.ts`

#### Specification

```typescript
export interface EventRow {
  global_position: string; // pg returns BIGSERIAL as string by default
  event_id: string;
  type: string;
  payload: Record<string, unknown>;   // pg auto-parses JSONB
  metadata: Record<string, unknown> | null;
  occurred_at: Date;                  // pg auto-parses TIMESTAMPTZ
}

export function mapRow(row: EventRow): StoredEvent
```

Key conversions:
- `row.global_position` (string) → `BigInt(row.global_position)` (bigint)
- `row.event_id` → string as-is
- `row.type` → string as-is
- `row.payload` → already parsed by `pg`, pass through
- `row.metadata` → already parsed by `pg`, preserve `null`
- `row.occurred_at` → `Date` object (already a `Date` from `pg`)

**Important:** `pg` returns `BIGSERIAL` values as strings. Do not use `parseInt()` (loses precision for values >2^53). Use `BigInt()`.

#### Tests
`tests/unit/row-mapper.test.ts`

**Basic mapping:**
- All fields are mapped to correct `StoredEvent` property names
- `global_position: '42'` → `globalPosition: 42n` (BigInt)
- `event_id: 'uuid-string'` → `eventId: 'uuid-string'`
- `occurred_at: new Date('2024-01-01')` → `occurredAt` is a `Date` instance

**BigInt precision:**
- `global_position: '9007199254740993'` (> Number.MAX_SAFE_INTEGER) → `9007199254740993n` (exact)
- `global_position: '1'` → `1n`
- `global_position: '0'` → `0n` (edge: zero)

**Metadata handling:**
- `metadata: null` → `StoredEvent.metadata` is `null` (not `undefined`, not `{}`)
- `metadata: { correlationId: 'x' }` → preserved as-is
- `metadata: {}` → empty object (not null)

**Payload handling:**
- `payload: {}` → empty object
- `payload: { nested: { deep: true } }` → deep structure preserved
- `payload: { count: 0 }` → falsy number preserved

**Type preservation:**
- Result is assignable to `StoredEvent` (type-level check)
- `typeof result.globalPosition === 'bigint'`
- `result.occurredAt instanceof Date`

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] `npm run typecheck` passes

---

### T-08 — Integration Test Infrastructure

**Status:** `done`
**Claimed by:** —
**Depends on:** T-01
**Blocks:** T-09, T-10, T-11, T-12 (integration tests)

#### Goal
Set up the integration test infrastructure: a `globalSetup` file that starts a PostgreSQL container before all integration tests run, exposes the connection string, and tears it down after. Provide shared helpers used by all integration test files.

#### Files to create
- `tests/integration/setup.ts` — vitest `globalSetup`
- `tests/integration/helpers.ts` — shared test utilities

#### Specification

**`setup.ts`** (vitest `globalSetup`):
- `setup()`: start a `PostgreSqlContainer` (PostgreSQL 15), wait until healthy, store connection string in `process.env.TEST_DATABASE_URL`
- `teardown()`: stop the container
- Container image: `postgres:15-alpine` (smaller, faster pull)
- `setup()` must complete in < 60 seconds (containers can be slow on first pull)

**`helpers.ts`**:
```typescript
// Creates a new pg.Pool connected to TEST_DATABASE_URL
export function createTestPool(): pg.Pool

// Applies schema + clears events table — call in beforeEach to isolate tests
export async function resetDatabase(pool: pg.Pool): Promise<void>

// Insert raw events for test setup (bypasses the store)
export async function seedEvents(
  pool: pg.Pool,
  events: Array<{ type: string; payload: object; metadata?: object }>
): Promise<void>
```

`resetDatabase` should:
1. Call `applySchema` (idempotent)
2. `TRUNCATE events RESTART IDENTITY CASCADE`

#### Tests
`tests/integration/setup-smoke.test.ts`

- `TEST_DATABASE_URL` is defined after setup
- `createTestPool()` creates a pool that can execute `SELECT 1`
- `resetDatabase` runs without error on a fresh DB
- `resetDatabase` is idempotent (safe to call twice)
- `seedEvents` inserts rows that are readable via a raw query
- After `resetDatabase` following `seedEvents`, the table is empty again

#### Acceptance criteria
- [ ] `npm run test:integration` can find and execute at least one integration test
- [ ] Container starts and stops cleanly
- [ ] `TEST_DATABASE_URL` is correctly set and reachable

---

### T-09 — Event Store — `load()`

**Status:** `done`
**Claimed by:** —
**Depends on:** T-04, T-05, T-06, T-07, T-08
**Blocks:** T-10, T-11, T-12, T-13

#### Goal
Implement the `PostgresEventStore` class skeleton and the `load()` method. This is the foundation all other store tasks build on.

#### Files to create/modify
- `src/store/event-store.ts` (create — full class skeleton + `load`)

#### Specification

```typescript
export interface EventStoreConfig {
  pool: pg.Pool;
}

export class PostgresEventStore implements EventStore {
  constructor(config: EventStoreConfig) { ... }

  async initializeSchema(): Promise<void>
  async load(query: QueryDefinition): Promise<LoadResult>
  async append(events: NewEvent | NewEvent[], options?: AppendOptions): Promise<StoredEvent[]> { throw new Error('not implemented') }
  async *stream(query: QueryDefinition, options?: StreamOptions): AsyncGenerator<StoredEvent> { throw new Error('not implemented') }
  async close(): Promise<void>
}
```

**`load()` implementation:**
1. Compile query with `compileLoadQuery`
2. Execute `SELECT ... ORDER BY global_position ASC`
3. Map rows with `mapRow`
4. Compute `version`: if rows.length > 0 → `rows[rows.length-1].globalPosition`; else → `0n`
5. Return `{ events, version }`

**`initializeSchema()`**: call `applySchema(client)` using a client from the pool.

**`close()`**: call `pool.end()`.

#### Tests

`tests/unit/event-store-load.test.ts` (unit, mock pg)

Use a mock `pg.Pool` that returns controlled `QueryResult` objects.

- No rows → `{ events: [], version: 0n }`
- One row → `{ events: [mapped], version: <globalPosition of that row> }`
- Three rows → `{ events: [...3 mapped], version: <max globalPosition> }`
- Calls `pool.query` with the correct SQL and params (spy assertion)
- Pool query errors are wrapped in `EventStoreError`
- Results are in `global_position` order (order from DB is preserved)

`tests/integration/event-store-load.test.ts` (integration)

Setup: `beforeEach` calls `resetDatabase`.

- **Empty store:** `load(query.eventsOfType('X'))` → `{ events: [], version: 0n }`
- **Type filter:** seed 3 events of type A, 2 of type B → `load(query.eventsOfType('A'))` returns 3, version = globalPosition of 3rd A
- **Attr filter:** seed events with `{ customerId: 'c1' }` and `{ customerId: 'c2' }` → filter on `c1` returns only those
- **AND filter:** seed events with `{ a: 1, b: 2 }` and `{ a: 1, b: 3 }` → `.and` filter returns only exact match
- **OR filter:** seed events with `{ status: 'pending' }` and `{ status: 'active' }` → OR filter returns both
- **Multi-type query:** two-clause query returns events of both types in `global_position` order
- **Version is correct BigInt:** `version` equals `globalPosition` of the last returned event
- **Version from partial result:** two types exist, query for one type — version reflects only those events
- **No events matched:** `version: 0n` even if other types exist

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run typecheck` passes

---

### T-10 — Event Store — `append()` (no concurrency check)

**Status:** `done`
**Claimed by:** —
**Depends on:** T-09
**Blocks:** T-11

#### Goal
Implement `append()` without concurrency protection — `options` parameter is undefined. Events are inserted in a transaction; the stored results are returned.

#### Files to modify
- `src/store/event-store.ts`

#### Specification

**`append()` without `AppendOptions`:**

```
BEGIN (dedicated client from pool)
  FOR EACH event:
    INSERT INTO events (type, payload, metadata)
    VALUES ($1, $2::jsonb, $3::jsonb)
    RETURNING global_position, event_id, type, payload, metadata, occurred_at
COMMIT
→ return StoredEvent[] in insert order
```

- Single event or array of events both accepted
- Each event is inserted in a separate `INSERT ... RETURNING` statement (not a batch insert)
- All inserts share a single transaction — either all succeed or all rollback
- `metadata` may be `undefined` in `NewEvent` → insert as `NULL` (pass `null` to pg, not the string `'null'`)
- `payload` must be serialized as JSONB (pass as JS object; `pg` handles serialization)

#### Tests

`tests/unit/event-store-append.test.ts` (unit, mock pg)

- Single `NewEvent` returns array of one `StoredEvent`
- Array of `NewEvent[]` returns array of same length in insert order
- `metadata: undefined` → INSERT receives `null` for metadata param
- `metadata: { key: 'val' }` → INSERT receives the object
- Each insert calls `RETURNING` (spy: verify SQL contains `RETURNING`)
- `BEGIN` and `COMMIT` are called exactly once per `append` call
- On INSERT error → `ROLLBACK` is called, error is wrapped in `EventStoreError`

`tests/integration/event-store-append.test.ts` (integration)

- **Single event:** `append({ type: 'A', payload: { x: 1 } })` returns `[StoredEvent]`
  - `globalPosition` is a BigInt ≥ 1n
  - `eventId` is a UUID string (matches `/^[0-9a-f-]{36}$/`)
  - `type === 'A'`
  - `payload` equals `{ x: 1 }`
  - `metadata === null`
  - `occurredAt` is a recent Date
- **Multiple events:** `append([e1, e2, e3])` returns 3 StoredEvents with sequential positions
- **With metadata:** `{ metadata: { correlationId: 'x' } }` → `metadata.correlationId === 'x'`
- **Atomic rollback:** if second of three inserts fails (simulate by violating a constraint), none of the events are persisted
- **`options: undefined`:** append without options → no concurrency check, always succeeds
- **Sequential positions:** positions from multiple appends are strictly increasing
- **Load after append:** events appended are visible to subsequent `load()` calls

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run typecheck` passes

---

### T-11 — Event Store — `append()` with Advisory Locks

**Status:** `done`
**Claimed by:** —
**Depends on:** T-10
**Blocks:** T-13

#### Goal
Extend `append()` to handle `AppendOptions`: acquire an advisory lock, perform a version check, throw `ConcurrencyError` on mismatch, and release the lock on commit/rollback.

#### Files to modify
- `src/store/event-store.ts`

#### Specification

**Full `append()` with `AppendOptions`:**

```
BEGIN (dedicated client)

  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30s';

  1. Acquire per-stream advisory lock (non-blocking):
     SELECT pg_try_advisory_xact_lock(
       hashtext($canonicalKey)
     ) AS acquired
     -- canonicalKey = compileCanonicalKey(options.concurrencyQuery ?? options.query)

     IF acquired = false:
       ROLLBACK; throw ConcurrencyError(expectedVersion, expectedVersion)
       -- Note: actual version is unknown when lock is not acquired; use expectedVersion for both

  2. Version check:
     SELECT COALESCE(MAX(global_position), 0) AS max_pos
     FROM events WHERE <compileVersionCheckQuery(concurrencyQuery ?? query)>

     actualVersion = BigInt(max_pos)
     IF actualVersion !== expectedVersion:
       ROLLBACK; throw ConcurrencyError(expectedVersion, actualVersion)

  3. Insert all events (same as no-concurrency path)

COMMIT
```

**Advisory lock key:** `hashtext` is a built-in PostgreSQL function that produces an `int4` from a string. The canonical key from `compileCanonicalKey` ensures two logically equivalent queries hash to the same int4.

**`SET LOCAL`:** Session-scoped timeouts reset automatically on transaction end — no cleanup needed.

#### Tests

`tests/unit/event-store-concurrency.test.ts` (unit, mock pg)

Use a mock client that records all SQL calls in order.

- When `options` is provided, `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` are called first
- `SELECT pg_try_advisory_xact_lock(...)` is called before the version check
- When advisory lock returns `false` → `ConcurrencyError` is thrown, `ROLLBACK` is called, no INSERT executed
- When version check returns `max_pos = 5`, `expectedVersion = 5n` → INSERT proceeds
- When version check returns `max_pos = 5`, `expectedVersion = 3n` → `ConcurrencyError(3n, 5n)` is thrown
- `ROLLBACK` is called on `ConcurrencyError`, not `COMMIT`
- `concurrencyQuery` is used for both the lock key and the version check when provided
- When `concurrencyQuery` is absent, `query` is used for both

`tests/integration/event-store-concurrency.test.ts` (integration)

- **First write (version 0):** seed no events, `expectedVersion: 0n` → succeeds
- **Correct version:** seed 1 event (version 1), read version from `load()`, append with that version → succeeds
- **Stale version:** seed 1 event, append with `expectedVersion: 0n` → `ConcurrencyError` thrown
- **Stale version details:** `error.expectedVersion === 0n`, `error.actualVersion === 1n`
- **No side effects on error:** after `ConcurrencyError`, subsequent `load()` shows no new events
- **Concurrent writes:** use two separate `PostgresEventStore` instances; both load version 0; both try to append with `expectedVersion: 0n`; exactly one succeeds, the other throws `ConcurrencyError`
- **`concurrencyQuery` override:** load a broad query (type A + type B), append with a narrow `concurrencyQuery` (type A only); a concurrent write to type B does not trigger a conflict
- **Version advances correctly:** after successful append, next `load()` returns new version; append with that new version succeeds

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run typecheck` passes
- [ ] The concurrent-write test demonstrates only one of two simultaneous appends succeeds

---

### T-12 — Event Store — `stream()`

**Status:** `done`
**Claimed by:** —
**Depends on:** T-09
**Blocks:** T-13

#### Goal
Implement `stream()` using application-level keyset pagination. Each page is a short independent query — no long-lived transactions, no server-side cursors.

#### Files to modify
- `src/store/event-store.ts`

#### Specification

```typescript
async *stream(query: QueryDefinition, options: StreamOptions = {}): AsyncGenerator<StoredEvent> {
  const batchSize = options.batchSize ?? 100;
  let lastPosition = options.afterPosition ?? 0n;

  while (true) {
    const { sql, params } = compileStreamQuery(query, lastPosition, batchSize);
    const result = await this.pool.query(sql, params);

    for (const row of result.rows) {
      const event = mapRow(row);
      yield event;
      lastPosition = event.globalPosition;
    }

    if (result.rowCount === null || result.rowCount < batchSize) break;
  }
}
```

Key behaviors:
- `rowCount < batchSize` signals the last page — stop iterating
- `rowCount === batchSize` — may be more pages, continue
- `rowCount === 0` — empty first page, yield nothing
- Caller `break`ing the `for await` loop stops the generator cleanly (generator cleanup via generator protocol)
- No transactions are opened; each query uses the pool directly
- No connections are held between pages

#### Tests

`tests/unit/event-store-stream.test.ts` (unit, mock pg)

Mock `pool.query` to return controlled rows.

- Empty result on first call → generator yields nothing (zero iterations)
- 50 rows with `batchSize=100` → yields all 50, stops (rowCount < batchSize)
- 100 rows, then 0 rows with `batchSize=100` → yields all 100, makes second call, stops
- 100 rows, then 50 rows with `batchSize=100` → yields 150 total (two pages)
- `afterPosition: 5n` → first query's `global_position > 5` param is correct
- `batchSize: 10` → LIMIT is 10 in first query
- `lastPosition` is updated between pages (second query uses last row's position)
- Pool `query` error → wrapped in `EventStoreError` and propagated

`tests/integration/event-store-stream.test.ts` (integration)

- **Empty stream:** `stream(query.eventsOfType('Nonexistent'))` → zero events yielded
- **Single page:** seed 5 events, `batchSize=100` → all 5 yielded in `global_position` order
- **Multiple pages:** seed 25 events, `batchSize=10` → all 25 yielded across 3 pages
- **`afterPosition`:** seed 10 events, stream with `afterPosition=5n` → only events with position > 5 yielded
- **Order guarantee:** all yielded events are in strict ascending `globalPosition` order
- **Early break:** seed 20 events; break after receiving 5 → no error; remaining events are not fetched (verify with spy or by counting pool queries)
- **Multi-type query:** stream events matching two types → both types appear, in position order
- **Attr filter:** stream with payload filter → only matching events yielded
- **Default `batchSize`:** 100 events seeded, stream without specifying `batchSize` → all yielded in two or fewer queries
- **New events during stream:** stream is a point-in-time snapshot per page; new events appended between pages may or may not appear (implementation-defined — document the behavior, test it consistently)

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] `npm run typecheck` passes
- [ ] Early-break test confirms no connection is held open after break

---

### T-13 — Public API Barrel + Build Verification

**Status:** `done`
**Claimed by:** —
**Depends on:** T-09, T-10, T-11, T-12
**Blocks:** nothing

#### Goal
Wire the public-facing `src/index.ts` barrel, verify the build produces correct ESM and CJS output, and confirm no internal implementation details leak through the public API.

#### Files to create/modify
- `src/index.ts` (create)

#### Specification

```typescript
export { query } from './query/query-object.js';
export type { QueryDefinition } from './query/types.js';
export type {
  NewEvent,
  StoredEvent,
  LoadResult,
  AppendOptions,
  StreamOptions,
  EventStore,
} from './types.js';
export { PostgresEventStore } from './store/event-store.js';
export type { EventStoreConfig } from './store/event-store.js';
export { ConcurrencyError, EventStoreError } from './errors.js';
```

**Not exported (internal):**
- `Clause`, `FilterNode` (query internals)
- `ClauseBuilder`, `KeySelector`, `ValueSetter` (builder internals)
- `compileLoadQuery`, `compileVersionCheckQuery`, `compileStreamQuery`, `compileCanonicalKey` (compiler internals)
- `mapRow`, `EventRow` (row mapper internals)
- `applySchema` (schema internals)

#### Tests

`tests/unit/public-api.test.ts`

- `query` is importable from the barrel
- `PostgresEventStore` is importable from the barrel
- `ConcurrencyError` is importable and is a class (can be used with `instanceof`)
- `EventStoreError` is importable and is a class
- Type exports compile correctly (import type assertions)
- `ClauseBuilder` is NOT exported from the barrel (access attempt is a type error)
- `compileLoadQuery` is NOT exported from the barrel
- `mapRow` is NOT exported from the barrel

**Build verification** (run via `npm run build`):
- `dist/index.js` exists (ESM)
- `dist/index.cjs` exists (CJS)
- `dist/index.d.ts` exists (type declarations)
- `dist/index.d.cts` exists (CJS type declarations)
- ESM import: `import { query, PostgresEventStore, ConcurrencyError } from './dist/index.js'` works in a Node.js ESM script
- CJS require: `const { query, PostgresEventStore } = require('./dist/index.cjs')` works in a Node.js CJS script
- `npm run typecheck` passes with zero errors

**Smoke test** (manual or scripted, included in verification):
```typescript
import { query, PostgresEventStore, ConcurrencyError } from './dist/index.js';
// Create store, initializeSchema, append event, load event, verify ConcurrencyError
```

#### Acceptance criteria
- [ ] All unit tests pass
- [ ] `npm run build` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] ESM and CJS outputs are both importable in a Node.js script
- [ ] No internal types are visible from the public API

---

## Test Strategy Summary

| Task | Unit tests (no DB) | Integration tests (real DB) | Test file(s) |
|------|--------------------|------------------------------|--------------|
| T-02 | Type-level (tsc) | — | `query-types.test.ts` |
| T-03 | Yes (DSL chains, immutability) | — | `query-builder.test.ts` |
| T-04 | Yes (SQL output) | — | `query-compiler.test.ts` |
| T-05 | Yes (error classes) | — | `errors.test.ts` |
| T-06 | Yes (DDL strings) | Yes (idempotency, pg_catalog) | `schema.test.ts` |
| T-07 | Yes (field mapping) | — | `row-mapper.test.ts` |
| T-08 | — | Yes (container smoke) | `setup-smoke.test.ts` |
| T-09 | Yes (mock pg) | Yes (all filter combos) | `event-store-load.test.ts` |
| T-10 | Yes (mock pg) | Yes (insert, rollback) | `event-store-append.test.ts` |
| T-11 | Yes (mock pg, SQL order) | Yes (concurrent writes) | `event-store-concurrency.test.ts` |
| T-12 | Yes (mock pg, pagination) | Yes (multi-page, early break) | `event-store-stream.test.ts` |
| T-13 | Yes (API surface) | — | `public-api.test.ts` |

**Speed targets:**
- Unit tests: entire suite < 5 seconds
- Integration tests: entire suite < 60 seconds (container startup amortised across all tests)
- `npm run test:unit` must be runnable on every file save in watch mode

---

## Definition of Done

A task is **done** when:
1. All listed files are created/modified
2. All specified tests exist and pass (`npm run test:unit` and/or `npm run test:integration`)
3. `npm run typecheck` reports zero errors
4. The task's acceptance criteria checkboxes are all ticked
5. No regressions in previously completed tasks
