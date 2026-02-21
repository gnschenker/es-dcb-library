# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Commands

```bash
# Install dependencies
npm install

# Type-check (no emit)
npm run typecheck

# Run all tests
npm test

# Unit tests only (no database required — fast, run on every change)
npm run test:unit

# Integration tests only (spins up a PostgreSQL container via testcontainers)
npm run test:integration

# Run a single test file
npx vitest run tests/unit/query-builder.test.ts

# Run tests in watch mode
npm run test:watch

# Build the library (ESM + CJS + .d.ts)
npm run build
```

The integration test suite starts a PostgreSQL 15 Docker container automatically. Docker must be running. First run is slower (image pull); subsequent runs reuse the cached image.

---

## Architecture

This is a TypeScript event sourcing library implementing the **DCB (Dynamic Context Boundaries)** pattern. There are no aggregates — context is defined dynamically at runtime by query objects.

### Layer overview

```
src/query/          Query DSL — pure TypeScript, no I/O
  types.ts          Internal data model: QueryDefinition, Clause, FilterNode
  builder.ts        Fluent immutable builder: ClauseBuilder / KeySelector / ValueSetter
  query-object.ts   Public entry point: query.eventsOfType() / query.allEventsOfType()
  compiler.ts       QueryDefinition → parameterized SQL strings + canonical lock key

src/
  types.ts          Public domain types: NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore
  errors.ts         ConcurrencyError, EventStoreError

src/store/
  schema.ts         DDL — applySchema(client): creates table + indexes + autovacuum settings
  row-mapper.ts     pg ResultRow → StoredEvent (handles BigInt conversion)
  event-store.ts    PostgresEventStore — the concrete EventStore implementation

src/index.ts        Public API barrel (only export from here)
```

### Query DSL

`ClauseBuilder` is the central type — it implements `QueryDefinition` and is returned at every step of the chain. `.where`, `.and`, `.or` are **property getters** (not method calls) that return a `KeySelector`. Every `equals()` call returns a **new** immutable `ClauseBuilder` — existing instances are never mutated.

```typescript
query.eventsOfType('OrderCreated')
  .where.key('customerId').equals('c1')
  .and.key('region').equals('EU')
  .eventsOfType('OrderShipped')
    .where.key('orderId').equals('o1')
```

Multiple `.eventsOfType()` calls add clauses; at SQL level clauses are OR-ed together, so the above query returns events of both types.

### Compiler

`compiler.ts` has four functions:
- `compileLoadQuery` — `SELECT ... ORDER BY global_position ASC`
- `compileVersionCheckQuery` — `SELECT COALESCE(MAX(global_position),0)` (for concurrency check)
- `compileStreamQuery` — load query + `AND global_position > $N LIMIT $M` (keyset pagination)
- `compileCanonicalKey` — deterministic string for advisory lock hashing (clauses sorted, keys sorted)

All use `$N`-style parameterization; parameters are returned alongside SQL.

### Concurrency — advisory locks

`append()` with `AppendOptions` serializes concurrent writers per logical stream using `pg_try_advisory_xact_lock(hashtext(canonicalKey))`. This is a **non-blocking** transaction-scoped lock — it either acquires immediately or returns `false` (→ `ConcurrencyError`). The lock is released automatically on `COMMIT`/`ROLLBACK`. This prevents the lost-update race that would exist under READ COMMITTED with a bare `SELECT MAX` check.

Transaction order inside `append()` with options:
1. `SET LOCAL lock_timeout = '5s'` / `SET LOCAL statement_timeout = '30s'`
2. `SELECT pg_try_advisory_xact_lock(...)` — if `false`, rollback + `ConcurrencyError`
3. `SELECT COALESCE(MAX(global_position), 0)` — version check
4. `INSERT ... RETURNING` for each event
5. `COMMIT`

### Streaming — keyset pagination

`stream()` is an `AsyncGenerator` that issues repeated short `SELECT` queries (`AND global_position > $last LIMIT $batchSize`). There are no long-lived transactions and no server-side cursors — this is intentional to avoid holding the `xmin` horizon and blocking autovacuum.

### Schema design notes

- `idx_events_type` is **not created** — it is fully covered by the composite `idx_events_type_position (type, global_position)`
- GIN index uses `jsonb_path_ops` (smaller and faster for `@>` containment queries than `jsonb_ops`)
- GIN pending list is set to 64 MB to reduce write-amplification spikes at high insert rates
- BRIN index on `occurred_at` is tiny and near-zero write cost (naturally correlated with insert order)
- Autovacuum thresholds are tightened (`scale_factor=0.01`) — defaults are too permissive at OLTP rates

### Key design decisions (see `.docs/` for full rationale)

- **No ORM** — raw SQL via `pg` for full control over indexes and query shapes
- **`pg` returns `BIGSERIAL` as strings** — always convert with `BigInt()`, never `parseInt()` (loses precision above 2^53)
- **Dual ESM+CJS output** — `tsup` + `exports` field in `package.json` avoids the dual-package hazard
- **`metadata` is nullable** — `undefined` in `NewEvent` becomes `NULL` in the DB; `StoredEvent.metadata` is `Record<string,unknown> | null`

---

## Git Flow

The remote repository is **`es-dcb-library`** on GitHub. The local repo is already initialised and connected. Use the `gh` CLI for all PR and review operations.

Every task from `.docs/implementation-plan.md` follows this flow:

### 1. Before starting a task

```bash
# Make sure main is up to date
git checkout main && git pull

# Create a branch for the task
git checkout -b task/T-XX-short-description
```

Update the task row in `.docs/implementation-plan.md`: **Status** → `in implementation`, **Claimed by** → your agent ID.

### 2. Implement the task

Write source files and test files as specified in the task. Commit in logical increments on the branch.

### 3. Run and verify locally

```bash
npm run typecheck          # must exit 0
npm run test:unit          # must exit 0
npm run test:integration   # must exit 0 (if task has integration tests)
npm run build              # must exit 0 (for T-13 and any public-API change)
```

All checks must be green before opening a PR.

### 4. Push and open a Pull Request

```bash
git push -u origin task/T-XX-short-description

gh pr create \
  --title "feat: T-XX <description>" \
  --body "Implements task T-XX from .docs/implementation-plan.md" \
  --base main
```

Spawn a **reviewer agent** and provide it with:
- The PR number / URL (from `gh pr create` output)
- The task specification section from `.docs/implementation-plan.md`

The reviewer reads the PR diff via `gh pr diff <number>` and posts a structured review via:

```bash
gh pr review <number> --comment --body "..."
```

Review issues are categorised as:
- **Critical** — correctness bugs, data-loss risks, security issues → must fix before merge
- **Medium** — missing edge cases, performance problems, API inconsistencies → must fix before merge
- **Minor** — style, naming, non-blocking improvements → implementing agent decides

### 5. Address issues and push fixes

The implementing agent fixes all Critical and Medium issues, commits to the **same branch**, re-runs all checks, then pushes:

```bash
git push
```

The reviewer agent reads the updated diff and posts a follow-up review comment via `gh pr review`. Repeat until no Critical or Medium issues remain.

### 6. Final approval and merge

Once the reviewer is satisfied, it posts an approval:

```bash
gh pr review <number> --approve --body "All critical and medium issues resolved. Approved."
```

Then merge using a normal merge (not squash):

```bash
gh pr merge <number> --merge --delete-branch
```

`--merge` produces a merge commit (`--no-ff` equivalent). Never use `--squash` or `--rebase`.

### 7. Update task status

After the PR is merged, update `.docs/implementation-plan.md`:
- **Status** → `done`
- Clear **Claimed by**

```bash
git checkout main && git pull
```

---

## Reference Docs

All design documents are in `.docs/`:

| File | Purpose |
|------|---------|
| `plan.md` | High-level design: schema, query DSL, concurrency algorithm, streaming |
| `architecture-review.md` | Tech stack justification (TypeScript vs Rust/C, cross-language FFI analysis) |
| `implementation-plan.md` | Task-by-task breakdown with test specifications and status tracking |
