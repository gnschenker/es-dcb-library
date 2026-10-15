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

# Operational benchmarks (Docker / testcontainers; not part of CI)
npm run bench
```

The integration test suite starts a PostgreSQL 15 Docker container automatically. Docker must be running. First run is slower (image pull); subsequent runs reuse the cached image.

---

## Architecture

This is a TypeScript event sourcing library implementing the **DCB (Dynamic Consistency Boundary)** pattern. There are no aggregates — context is defined dynamically at runtime by query objects.

### Layer overview

```
src/query/          Tag-based query API — pure TypeScript, no I/O
  types.ts          Query / QueryItem (OR across items; AND of types/tags within an item)
  builder.ts        query() / queryItem() / queryAll() / combineQueries()
  compiler.ts       Query → parameterized SQL (committed load/stream/exists) + lock pairs

src/
  types.ts          Public domain types: NewEvent, StoredEvent, LoadResult, AppendCondition, StreamCursor, EventStore
  errors.ts         ConcurrencyError, EmptyBatchError, typed pg errors, projection errors

src/store/
  schema.ts         DDL — applySchema(client): creates table + indexes + autovacuum settings
  row-mapper.ts     pg ResultRow → StoredEvent (handles BigInt conversion)
  event-store.ts    PostgresEventStore — the concrete EventStore implementation

src/index.ts        Public API barrel (only export from here)

src/projections/    Projections addon — separate subpath export (es-dcb-library/projections)
  index.ts          Public barrel for the projections subpath
  types.ts          defineProjection(), createEventDispatcher(), ProjectionDefinition, handler types
  schema.ts         DDL constants + applyProjectionSchema(client)
  loop.ts           Internal: processEvent (atomic), runCatchUp, runLive, runProjectionLoop, ManagedListenClient
  manager.ts        ProjectionManager class
```

### Query API

Queries are tag-based (`query()`, `queryItem()`, `queryAll()`, `combineQueries()`). There is no payload-path fluent DSL.

```typescript
const orderQuery = queryItem({
  types: ['OrderCreated', 'OrderShipped'],
  tags: [`order:${orderId}`],
});

const { events, position } = await store.load(orderQuery);
await store.append(newEvents, { failIfEventsMatch: orderQuery, after: position });
```

Items are OR-ed. Within an item, `types` is OR (empty = any type) and `tags` is AND (empty = any tags). `load()` returns only committed-visible events, ordered by `(tx_id, global_position)`. Always pass the full `position` (including `readXmin`) to `after`. `readXmin` is bound to that cursor (`txId < readXmin`); a stitched pair throws `InconsistentStreamCursorError`.

### Compiler

`compiler.ts` (committed path used by the store):
- `compileLoadCommittedQuery` — `SELECT ... WHERE … AND tx_id < pg_snapshot_xmin(...) ORDER BY tx_id, global_position`
- `compileExistsQuery` — append condition; includes late-commit holes when `after.readXmin` is set
- `compileStreamTagExistsQuery` — single-item single-tag cross-type race
- `compileCommittedStreamQuery` — keyset pagination on `(tx_id, global_position)`
- `extractLockPairs` / `extractLockPairsFromEvents` / `withWildcardTagLocks` — sorted `(type, tag)` plus `(*, tag)`

Legacy `compileLoadQuery` / `compileStreamQuery` (global_position order) remain for non-`committedOnly` streams. All use `$N`-style parameterization.

### Concurrency — advisory locks

Conditional `append()` serializes overlapping writers with **blocking** `pg_advisory_xact_lock(hashtext(type:tag))` on the union of:
- `(type, tag)` pairs from `failIfEventsMatch`
- `(type, tag)` pairs from the events being appended
- `(*, tag)` for each distinct tag

Locks are taken in sorted order (deadlock avoidance), then the exists check runs. `ConcurrencyError` means the condition failed, not that the lock was busy. `lock_timeout` / deadlock / serialization failure map to `LockTimeoutError` / `DeadlockError` / `SerializationFailureError`.

Transaction order inside conditional `append()`:
1. Validate the batch (empty → `EmptyBatchError`; tags/extractors) **before** `BEGIN`
2. `BEGIN` then `SET LOCAL lock_timeout = '5s'` / `SET LOCAL statement_timeout = '30s'`
3. Acquire advisory locks
4. `failIfEventsMatch` exists check (plus tag-stream exists when the condition is one item / one tag)
5. `INSERT ... RETURNING` for each event
6. `COMMIT` — every failure after `BEGIN` rolls back in a `finally`-safe path

Omitting `condition` is atomic but does **not** take DCB locks.

### Streaming — keyset pagination

`stream()` issues repeated short `SELECT`s. `committedOnly: true` paginates on `(tx_id, global_position)` with `tx_id < pg_snapshot_xmin`. Legacy `afterPosition` streams use `global_position` only and can see out-of-order commits. No server-side cursors and no long-lived transactions — this avoids holding the `xmin` horizon and blocking autovacuum.

### Schema design notes

- `idx_events_type` is **not created** — it is fully covered by the composite `idx_events_type_position (type, global_position)`
- GIN index is on `tags` (`array_ops`) for `@>` containment; event `data` is not indexed
- GIN pending list is set to 64 MB to reduce write-amplification spikes at high insert rates
- BRIN index on `occurred_at` is tiny and near-zero write cost (naturally correlated with insert order)
- Autovacuum thresholds are tightened (`scale_factor=0.01`) — defaults are too permissive at OLTP rates

### Key design decisions (see `.docs/` for full rationale)

- **No ORM** — raw SQL via `pg` for full control over indexes and query shapes
- **`pg` returns `BIGSERIAL` as strings** — always convert with `BigInt()`, never `parseInt()` (loses precision above 2^53)
- **Dual ESM+CJS output** — `tsup` + `exports` field in `package.json` avoids the dual-package hazard
- **`metadata` is nullable** — `undefined` in `NewEvent` becomes `NULL` in the DB; `StoredEvent.metadata` is `Record<string,unknown> | null`

### Projections design decisions

- **Addon, not modification** — `src/index.ts` is never touched; projections live under `src/projections/` and export from the `./projections` subpath
- **Dedicated `pg.Client` for LISTEN** — pool connections lose LISTEN state when returned; `ManagedListenClient` holds one persistent `pg.Client` with exponential-backoff reconnect (1 s → 60 s cap)
- **Shared LISTEN client started before loops** — gap-free guarantee: `initialize()` starts the client, then `start()` spawns loops; no notifications are missed during catch-up
- **FOR EACH STATEMENT trigger** — one `pg_notify` per `store.append()` call regardless of batch size; prevents thundering herd
- **NOTIFY payload is empty string** — receiver unconditionally drains from `state.lastCursor`; no need to parse the payload
- **Atomic handler + checkpoint** — `BEGIN → handler → UPDATE projection_checkpoints → COMMIT`; crash before COMMIT replays the event; handlers must be idempotent (`INSERT … ON CONFLICT DO UPDATE`)
- **dryRun mode** — handler called in real transaction, but always rolled back; use for SQL validation without side effects
- **singleInstance** — `pg_try_advisory_lock(hashtext(name))` (session-level, not transaction-scoped) on a dedicated `pg.Client`; client held for the life of the loop; released on `stop()` / `lockClient.end()`. Contrast with `append()` which uses blocking `pg_advisory_xact_lock` (transaction-scoped, auto-released on COMMIT/ROLLBACK).
- **`applyProjectionSchema` is internal** — `src/projections/schema.ts` exports `applyProjectionSchema(client)` at the module level (used by `ProjectionManager.initialize()` and integration tests) but it is **not** re-exported from `src/projections/index.ts`. External consumers of `es-dcb-library/projections` cannot call it directly; schema application is managed entirely through `manager.initialize()`.
- **`Promise.allSettled` in `stop()`** — crashed loop does not block shutdown of healthy loops
- **Per-projection loops, not shared** — isolation: slow or errored projection does not delay others
- **`waitUntilLive()`** — succeeds only when every projection is `live`; `error`/`stopped` throw `ProjectionNotReadyError`
- **`waitForCursor()`** — `(tx_id, global_position)` watermark; `waitForPosition()` is last_position only
- **Setup timeout** — `statement_timeout` + `pg_cancel_backend`; first LISTEN connect failure fails `initialize()`

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

---

## University Example App (`university-app/`)

The `university-app/` subdirectory is an example application built on top of this library. It follows a **vertical slice architecture**.

### Architectural principle: autonomous slices

Every feature (API endpoint → command handler → events) is a **self-contained slice**. Slices do not import from each other.

**Shared across slices (OK):**
- `es-dcb-library` — the underlying event-store library
- `es-dcb-library/projections` — the projections addon
- `src/domain/events.ts` — event payload type interfaces (the inter-slice contract)
- `src/domain/errors.ts` — domain error classes (used by the API error handler)
- `src/domain/clock.ts` — `Clock` interface and `systemClock` (pure utility)
- `src/domain/ids.ts` — deterministic ID generators (pure utility)
- `src/store.ts` — `createStore` factory (infrastructure)
- `src/projections/` — `ProjectionManager` wiring (infrastructure)

**Defined inside each slice (never shared):**
- Stream query builders (`queryItem({ types, tags })`) — every command handler defines its own
- Reducer functions — every command handler contains its own state-reduction logic
- Any business-rule helpers specific to that command

This means intentional duplication is acceptable and expected. Two command handlers that both need to reduce teacher state each define their own `reduceTeacher` function locally. The coupling that shared code introduces is worse than the duplication.

### Commands per task

For the university app, the Git flow follows `.docs/university-implementation-plan.md`, using `task/U-XX-*` branch names and `feat: U-XX <description>` PR titles.

```bash
# From university-app/
npm run typecheck
npm run test:unit
npm run test:integration
```

---

## Reference Docs

All design documents are in `.docs/`:

| File | Purpose |
|------|---------|
| `plan.md` | High-level design: schema, query DSL, concurrency algorithm, streaming |
| `architecture-review.md` | Tech stack justification (TypeScript vs Rust/C, cross-language FFI analysis) |
| `implementation-plan.md` | Task-by-task breakdown with test specifications and status tracking |
| `university-app-plan.md` | University app domain design: events, commands, business rules, API |
| `university-implementation-plan.md` | University app task-by-task implementation plan |
| `projections-plan.md` | Projections addon design: architecture, loop design, API, schema, tasks P-01–P-14 |
| `v2-migration.md` | v1 → v2 API: `load().position`, `EmptyBatchError`, projection readiness |
| `benchmarks.md` | Baseline throughput, latency, and query-plan observations |
