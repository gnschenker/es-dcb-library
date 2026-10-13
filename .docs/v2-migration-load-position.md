# v2.0.0 migration: commit-order-safe `load().position`

## Summary

`LoadResult.version: bigint` is replaced by **`LoadResult.position: StreamCursor`** (`{ txId, globalPosition }`).
`AppendCondition.after` is now a **`StreamCursor`**, not a `bigint`.

`load()` only returns **committed-visible** events, ordered by `(tx_id, global_position)` — the same rule as `stream({ committedOnly: true })`.

`load().position` includes **`readXmin`** (snapshot xmin at load time). Always pass the full object to `after` — do not strip fields.

## Why

PostgreSQL assigns `global_position` before commit. Using `MAX(global_position)` from a plain load allowed optimistic appends to succeed after a **late commit** of an older transaction (P0 #3).

Append conditions now treat a late lower `global_position` as a conflict when it appears after `load()`.

## Code changes

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

## `ConcurrencyError`

- `expectedVersion` / `actualVersion` → **`expectedPosition`** / **`actualPosition`** (`StreamCursor`).

## Advisory locks (P0 #1)

`append()` now locks the **union** of `(type, tag)` pairs from `failIfEventsMatch` **and** from the events being appended (resolved tags).

## Unchanged

- `stream({ committedOnly: true, afterCursor })` — same cursor type as `load().position`.
- Legacy `stream({ afterPosition })` without `committedOnly` is unchanged.
