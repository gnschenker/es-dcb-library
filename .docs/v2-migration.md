# v1 → v2 migration

This note covers the public API changes that land with **v2.0.0**. The version bump and changelog themselves are a separate release PR.

`LoadResult.version` and integer `after` were the P0 #3 fix. Empty batches, projection readiness, setup cancellation, tag validation, and typed PostgreSQL errors are the remaining v2 contracts.

## `load().position` and `after` (breaking)

`LoadResult.version: bigint` is replaced by **`LoadResult.position: StreamCursor`** (`{ txId, globalPosition, readXmin? }`).
`AppendCondition.after` is now a **`StreamCursor`**, not a `bigint`.

`load()` only returns **committed-visible** events, ordered by `(tx_id, global_position)` — the same rule as `stream({ committedOnly: true })`.

`load().position` includes **`readXmin`** (snapshot xmin at load time). Always pass the full object to `after` — do not strip fields or use `globalPosition` alone.

Do **not** mix `readXmin` from an older `load()` with a later event’s `txId` / `globalPosition`. After two or more writes, the late-commit hole check (`global_position < after.globalPosition AND tx_id >= readXmin`) treats earlier visible events as conflicts. Either call `load()` again for each decision, or pass `eventStreamCursor(stored)` **without** `readXmin` when the cursor is a known persisted event.

### Why

PostgreSQL assigns `global_position` before commit. Using `MAX(global_position)` from a plain load allowed optimistic appends to succeed after a **late commit** of an older transaction (P0 #3).

Append conditions now treat a late lower `global_position` as a conflict when it appears after `load()`.

### Code changes

```typescript
// v1
const { events, version } = await store.load(q);
await store.append(eventsToWrite, { failIfEventsMatch: q, after: version });

// v2
const { events, position } = await store.load(q);
await store.append(eventsToWrite, { failIfEventsMatch: q, after: position });
```

For manual conditions from a stored event:

```typescript
import { eventStreamCursor } from 'es-dcb-library';

await store.append(evt, { failIfEventsMatch: q, after: eventStreamCursor(lastEvent) });
```

Empty stream / first write:

```typescript
import { STREAM_CURSOR_ORIGIN } from 'es-dcb-library';

await store.append(evt, { failIfEventsMatch: q, after: STREAM_CURSOR_ORIGIN });
```

### `ConcurrencyError`

- `expectedVersion` / `actualVersion` → **`expectedPosition`** / **`actualPosition`** (`StreamCursor`).

### Advisory locks (P0 #1)

`append()` now locks the **union** of `(type, tag)` pairs from `failIfEventsMatch` **and** from the events being appended (resolved tags), plus **`(*, tag)`** for each distinct tag (serializes writers on the same tag even when event types differ).

When `failIfEventsMatch` is a **single item on one tag**, append also checks for any row with that tag and `global_position > after.globalPosition` (cross-type races). Multi-item or multi-tag conditions use typed `failIfEventsMatch` + locks only. Late-commit holes use `readXmin` on the typed exists check.

Locks are **blocking** `pg_advisory_xact_lock` (sorted to avoid deadlock). A wait that exceeds `lock_timeout` is `LockTimeoutError`, not `ConcurrencyError`.

## `EmptyBatchError` (breaking)

`append([])` throws **`EmptyBatchError`** before `BEGIN`. There is no empty successful write.

The full batch is validated (tags / extractors) before the transaction opens. A later invalid event rolls the batch back — zero rows persist, and the pool connection is not left idle-in-transaction.

## Projection readiness and setup (P1)

### `waitUntilLive()`

Success only when every configured projection is `live`. `error` and `stopped` throw **`ProjectionNotReadyError`** (including `singleInstance` lock not acquired). A timeout also throws `ProjectionNotReadyError`.

Do not treat “the wait returned” as “the read model is healthy” unless you catch that error.

### `waitForCursor()` vs `waitForPosition()`

- **`waitForCursor(name, StreamCursor)`** — commit-order watermark, same comparison as committed streams / `load().position`.
- **`waitForPosition(name, bigint)`** — convenience on checkpoint `last_position` only. It is **not** a commit-order watermark.

### Setup timeout

`setup()` sets PostgreSQL `statement_timeout`. On JS timeout the backend is cancelled (`pg_cancel_backend`) and the client is released only after setup settles. Timeout → **`ProjectionSetupTimeoutError`**.

The first LISTEN connect failure fails `initialize()` (it is not retried in the background while startup continues).

### Constructor

```typescript
// v1-shaped examples in older README copies
new ProjectionManager(store, pool, [projection]);

// actual API
new ProjectionManager({ pool, store, projections: [projection] });
await manager.initialize();
manager.start();           // synchronous; do not await
await manager.waitUntilLive();
```

## Tags and errors

- Explicit `event.tags` are first-class; a global `tagExtractors` registry is optional.
- Empty or whitespace tags throw **`InvalidTagError`**.
- SQLSTATE `55P03` / `40P01` / `40001` → **`LockTimeoutError`** / **`DeadlockError`** / **`SerializationFailureError`** (retryable `EventStoreError` subclasses).
- Payloads and metadata are stored as given. No automatic upcasting.

## Unchanged

- `stream({ committedOnly: true, afterCursor })` — same cursor type as `load().position`.
- Legacy `stream({ afterPosition })` without `committedOnly` is unchanged (not commit-order-safe).
- Query builders: `query()`, `queryItem()`, `queryAll()`, `combineQueries()`.
- University-app slice conventions stay in `university-app/`; they are not part of the library API.

## Further reading

- [Committed stream design](./committed-stream-design.md)
- [Benchmarks](./benchmarks.md)
