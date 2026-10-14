# es-dcb-library

[![CI](https://github.com/gnschenker/es-dcb-library/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gnschenker/es-dcb-library/actions/workflows/ci.yml)
[![Release](https://github.com/gnschenker/es-dcb-library/actions/workflows/release.yml/badge.svg)](https://github.com/gnschenker/es-dcb-library/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/es-dcb-library.svg)](https://www.npmjs.com/package/es-dcb-library)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/gnschenker/es-dcb-library/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-13%2B-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)

A TypeScript event sourcing library implementing the **Dynamic Consistency Boundary (DCB)** pattern.

## What is DCB?

Dynamic Consistency Boundary is an event sourcing architecture that eliminates aggregates and fixed stream boundaries. Instead, consistency contexts are defined dynamically at runtime through **queries over event types and tags**.

See the [DCB specification](https://dcb.events) for the full design.

## Key Features

- **No aggregates** — consistency boundaries are constructed ad-hoc per command
- **Tag-based queries** — events carry tags; queries select events by type and tag combinations
- **PostgreSQL-backed** — uses advisory locks for concurrency control, GIN indexes for tag queries
- **Type-safe** — full TypeScript support with generics for event data
- **Streaming** — memory-efficient keyset pagination (no cursors, no long transactions)
- **Projections addon** — separate `es-dcb-library/projections` subpath export for read models

---

## Installation

```bash
npm install es-dcb-library pg
```

### Requirements

- **Node.js** 18 or newer (`engines` in `package.json`)
- **PostgreSQL** 13 or newer

The event store stores each row’s inserting transaction id in a `tx_id` column (`xid8`, default `pg_current_xact_id()`). Committed-only streaming and projections compare `tx_id` to `pg_snapshot_xmin(pg_current_snapshot())`, which requires PostgreSQL **13+** (`xid8` and related snapshot APIs). PostgreSQL 12 and earlier are not supported.

You also need the **`pg`** driver (see install command above); it is a peer dependency of this package.

## Quick Start

### 1. Define your events

```typescript
// events.ts
export interface OrderCreated {
  orderId: string;
  customerId: string;
  items: { sku: string; qty: number }[];
}

export interface OrderShipped {
  orderId: string;
  shippedAt: string;
}
```

### 2. Create the event store

```typescript
import pg from 'pg';
import { PostgresEventStore, applySchema } from 'es-dcb-library';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
await applySchema(client);
client.release();

const store = new PostgresEventStore({
  pool,
  tagExtractors: {
    OrderCreated: (event) => [`order:${event.data.orderId}`, `customer:${event.data.customerId}`],
    OrderShipped: (event) => [`order:${event.data.orderId}`],
  },
});
```

Tag extractors are functions that derive tags from event data. Tags are merged with any explicitly provided tags on append.

### 3. Append events

```typescript
import { queryItem } from 'es-dcb-library';

const orderId = 'order-123';

await store.append([
  {
    type: 'OrderCreated',
    data: { orderId, customerId: 'c1', items: [{ sku: 'widget', qty: 2 }] },
  },
]);

// Later: append with optimistic concurrency check
const orderQuery = queryItem({ types: ['OrderCreated', 'OrderShipped'], tags: [`order:${orderId}`] });
const { position } = await store.load(orderQuery);

await store.append(
  [{ type: 'OrderShipped', data: { orderId, shippedAt: new Date().toISOString() } }],
  { failIfEventsMatch: orderQuery, after: position }
);
```

**Concurrency control:**  
`load()` returns only **committed-visible** events, ordered by `(tx_id, global_position)`. Pass the full `position` (`StreamCursor`, including `readXmin`) to `after` — do not pass a bare `globalPosition`. Do not reuse `readXmin` from an older load with a newer event’s `txId` / `globalPosition`.

`failIfEventsMatch` then checks whether any matching event appeared after that cursor (including a late commit of an older transaction). If so, a `ConcurrencyError` is thrown. PostgreSQL advisory locks (sorted `(type, tag)` pairs from the condition **and** the events being appended, plus `(*, tag)` for each tag) serialize overlapping writers. `ConcurrencyError` is an application-level condition failure, not lock contention. Lock timeout, deadlock, and serialization failure are separate typed errors (`LockTimeoutError`, `DeadlockError`, `SerializationFailureError`).

An empty `append([])` throws `EmptyBatchError` before opening a transaction. Omitting `condition` is still atomic per batch but **does not** take DCB locks — do not use it to protect a business invariant.

### 4. Query events

```typescript
import { query, queryItem } from 'es-dcb-library';

// Single query item
const orderEvents = await store.load(queryItem({ tags: [`order:${orderId}`] }));

// Multiple query items (OR semantics)
const multiQuery = query([
  { types: ['OrderCreated'], tags: [`customer:c1`] },
  { types: ['OrderShipped'], tags: [`order:${orderId}`] },
]);
const result = await store.load(multiQuery);

console.log(result.events);     // StoredEvent[] (committed-visible only)
console.log(result.position);   // StreamCursor { txId, globalPosition, readXmin }
```

**Query semantics:**
- A `Query` is an array of `QueryItem`s, combined with OR logic.
- Within a single `QueryItem`:
  - `types?: string[]` — matches events of these types (empty or omitted = any type)
  - `tags?: string[]` — matches events having **all** these tags (empty or omitted = any tags)

### 5. Stream large result sets

```typescript
for await (const event of store.stream(queryItem({ tags: [`customer:c1`] }), { batchSize: 100 })) {
  console.log(event.type, event.globalPosition);
}
```

Streaming uses keyset pagination (`WHERE global_position > $last LIMIT $batchSize`). No server-side cursors, no long transactions.

---

## API Reference

### Core Types

```typescript
interface NewEvent<D = Record<string, unknown>> {
  type: string;
  data: D;
  metadata?: Record<string, unknown>;
  tags?: string[];  // merged with tagExtractor output
}

interface StoredEvent<D = Record<string, unknown>> {
  globalPosition: bigint;
  eventId: string;
  type: string;
  data: D;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  tags: string[];
}

interface QueryItem {
  types?: readonly string[];  // OR within types, empty = all types
  tags?: readonly string[];   // AND across tags, empty = all tags
}

interface Query {
  items: readonly QueryItem[];  // OR across items
}

interface StreamCursor {
  txId: string;
  globalPosition: bigint;
  readXmin?: string;  // snapshot xmin captured by load(); pass through to after
}

interface LoadResult {
  events: StoredEvent[];
  position: StreamCursor;  // commit-order-safe head for this query
}

interface AppendCondition {
  failIfEventsMatch: Query;
  after?: StreamCursor;  // from load().position or STREAM_CURSOR_ORIGIN
}
```

### EventStore Interface

```typescript
interface EventStore {
  /** Atomic insert. Omit condition only when the batch is not protecting a decision. */
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]>;
  /** Committed-visible events, ordered by (tx_id, global_position). */
  load(query: Query): Promise<LoadResult>;
  stream(query: Query, options?: StreamOptions): AsyncIterable<StoredEvent>;
  initializeSchema(): Promise<void>;
  close(): Promise<void>;
}
```

### Errors

| Error | When |
| --- | --- |
| `ConcurrencyError` | `failIfEventsMatch` found matching events after `after` (`expectedPosition` / `actualPosition` are `StreamCursor`s) |
| `EmptyBatchError` | `append([])` — rejected before `BEGIN` |
| `MissingTagExtractorError` | no extractor, no explicit tags, not `UNTAGGED` |
| `InvalidTagError` | empty or whitespace tag (explicit or from an extractor) |
| `LockTimeoutError` | PostgreSQL `55P03` (retryable) |
| `DeadlockError` | PostgreSQL `40P01` (retryable) |
| `SerializationFailureError` | PostgreSQL `40001` (retryable) |
| `EventStoreError` | other store failures |
| `ProjectionNotReadyError` | `waitUntilLive` saw `error`/`stopped`, or timed out |
| `ProjectionSetupTimeoutError` | projection `setup()` exceeded `setupTimeoutMs` |

Event `data` and `metadata` are stored and returned as recorded. The library does not upcast or rewrite payloads.

See [`.docs/v2-migration.md`](.docs/v2-migration.md) for the v1 → v2 `version`/`after` change.

### Query Builders

```typescript
import { query, queryItem } from 'es-dcb-library';

// Single item
const q1 = queryItem({ types: ['OrderCreated'], tags: ['order:o1'] });

// Multiple items
const q2 = query([
  { types: ['OrderCreated'], tags: ['customer:c1'] },
  { types: ['OrderShipped'], tags: ['order:o1'] },
]);
```

### Combining Queries

For command handlers that load multiple streams, use `combineQueries` to merge them into a single query and cursor:

```typescript
import { query, combineQueries } from 'es-dcb-library';

function studentStream(studentId: string) {
  return query([
    { types: ['StudentRegistered'], tags: [`student:${studentId}`] },
    { types: ['StudentPassed'], tags: [`student:${studentId}`] },
  ]);
}

function courseStream(courseId: string) {
  return query([
    { types: ['CourseCreated'], tags: [`course:${courseId}`] },
    { types: ['CoursePublished'], tags: [`course:${courseId}`] },
  ]);
}

function enrollmentStream(studentId: string, courseId: string) {
  return query([
    { types: ['StudentEnrolled'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentDropped'], tags: [`student:${studentId}`, `course:${courseId}`] },
  ]);
}

// Load all three streams with a single position
const allStreams = combineQueries(
  studentStream('s1'),
  courseStream('c1'),
  enrollmentStream('s1', 'c1')
);

const { events, position } = await store.load(allStreams);

// Filter events for each reducer
const studentEvents = events.filter(e => e.tags.includes('student:s1'));
const courseEvents = events.filter(e => e.tags.includes('course:c1'));
const enrollmentEvents = events.filter(e => 
  e.tags.includes('student:s1') && e.tags.includes('course:c1')
);

// Reduce state, make decision, append with the single load() cursor
await store.append(newEvents, {
  failIfEventsMatch: allStreams,
  after: position,
});
```

**Why this matters**: Loading streams separately and picking `max(globalPosition)` is not a commit-order watermark. A single combined query plus `load().position` is the safe append condition.

### Tag Extractors

```typescript
import { PostgresEventStore, TagExtractor, UNTAGGED } from 'es-dcb-library';

const tagExtractors: Record<string, TagExtractor | typeof UNTAGGED> = {
  OrderCreated: (event) => [
    `order:${event.data.orderId}`,
    `customer:${event.data.customerId}`,
  ],
  OrderShipped: (event) => [`order:${event.data.orderId}`],
  SystemEvent: UNTAGGED,  // Intentionally has no tags
};

const store = new PostgresEventStore({ pool, tagExtractors });
```

**Strict tag extraction**: By default, appending an event without a registered extractor and without explicit tags throws `MissingTagExtractorError`. This prevents silently storing untagged events that queries won't find.

Slices can pass `tags` on the event without registering a global extractor. Empty or whitespace tags throw `InvalidTagError` (including tags produced by an extractor). Tag strings are part of the event contract: queries and DCB locks depend on them.

**Three ways to tag events**:
1. **Tag extractor**: Register a function for the event type
2. **Explicit tags**: Pass `tags: [...]` in the event (merged with extractor output; no extractor required)
3. **Mark as UNTAGGED**: Use the `UNTAGGED` symbol for types that intentionally have no tags

```typescript
// Allowed: has tag extractor
await store.append({ type: 'OrderCreated', data: { orderId: 'o1', customerId: 'c1' } });

// Allowed: explicit tags provided
await store.append({ type: 'UnknownEvent', data: {}, tags: ['tag:foo'] });

// Allowed: marked as UNTAGGED
await store.append({ type: 'SystemEvent', data: {} });

// Error: no extractor, no tags, not marked UNTAGGED
await store.append({ type: 'UnknownEvent', data: {} });
// throws MissingTagExtractorError
```

---

## Projections (Read Models)

The library includes a projections addon for building read models. Import from the `projections` subpath:

```typescript
import { defineProjection, createEventDispatcher, ProjectionManager } from 'es-dcb-library/projections';
import { queryItem } from 'es-dcb-library';

const ordersProjection = defineProjection({
  name: 'orders-read-model',
  
  query: queryItem({ types: ['OrderCreated', 'OrderShipped'] }),
  
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS read_orders (
        order_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        shipped_at TIMESTAMPTZ
      )
    `);
  },
  
  handler: createEventDispatcher({
    OrderCreated: async (data, _event, client) => {
      await client.query(
        `INSERT INTO read_orders (order_id, status) VALUES ($1, 'created')
         ON CONFLICT (order_id) DO NOTHING`,
        [data.orderId]
      );
    },
    OrderShipped: async (data, _event, client) => {
      await client.query(
        `UPDATE read_orders SET status = 'shipped', shipped_at = $1 WHERE order_id = $2`,
        [data.shippedAt, data.orderId]
      );
    },
  }),
});

const manager = new ProjectionManager({
  pool,
  store,
  projections: [ordersProjection],
});
await manager.initialize();
manager.start();
await manager.waitUntilLive();
```

**Readiness and progress:**
- `waitUntilLive()` resolves only when every configured projection is `live`. Any `error` or `stopped` status (including a single-instance lock miss) throws `ProjectionNotReadyError`.
- `waitForCursor(name, StreamCursor)` waits until the checkpoint is at or past the target in `(tx_id, global_position)` order — the same cursor as `load().position`.
- `waitForPosition(name, bigint)` is a convenience on `last_position` only. It is **not** a commit-order watermark; a higher position can become visible before an older transaction commits.

**Setup:** `setup()` runs with a PostgreSQL `statement_timeout`. If the JS timeout fires, the backend is cancelled (`pg_cancel_backend`) and the client is released only after setup settles. A timeout throws `ProjectionSetupTimeoutError`. The first LISTEN connect failure fails `initialize()` instead of being swallowed.

**Key projection features:**
- **Catch-up + live processing**: Each projection runs in a loop that first catches up from the `(tx_id, global_position)` checkpoint, then listens for live events via `LISTEN/NOTIFY`.
- **Atomic handler + checkpoint**: Each event is processed in a transaction that includes both the handler logic and the checkpoint update. Handlers must be idempotent (`INSERT ... ON CONFLICT` or `UPDATE WHERE`).
- **Isolation**: Each projection runs independently. A slow or errored projection does not block others.
- **Gap-free guarantee**: The shared LISTEN client is started before any projection loop begins, ensuring no notifications are missed during catch-up.
- **Committed-only streaming**: Projections read only rows with `tx_id < pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(tx_id, global_position)`, so they never skip events when transactions commit out of order. Sequence holes from rollbacks do not stall followers. See [Committed stream design](./.docs/committed-stream-design.md).

### Projection gap safety

PostgreSQL assigns `global_position` before commit, so T1 (position 100) may still be open while T2 (position 101) commits. A naive position-based stream would skip 100.

**Solution**: store `tx_id` on each event; followers use `committedOnly: true` and checkpoint `(last_tx_id, last_position)`. While any older transaction is active, its `tx_id` keeps `pg_snapshot_xmin` low enough that newer committed rows are withheld until it finishes.

See [`.docs/committed-stream-design.md`](./.docs/committed-stream-design.md) for rationale (including why gap-based “safe position” is not liveness-safe).

See `.docs/projections-plan.md` for full design details.

---

## Schema

The library manages a single `events` table:

```sql
CREATE TABLE events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  data             JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  tags             TEXT[]       NOT NULL,
  tx_id            xid8         NOT NULL DEFAULT pg_current_xact_id()
);

CREATE INDEX idx_events_tags_gin ON events USING GIN (tags array_ops);
CREATE INDEX idx_events_type_position ON events (type, global_position);
CREATE INDEX idx_events_occurred_at_brin ON events USING BRIN (occurred_at);
```

Call `applySchema(client)` to create the table and indexes.

### Autovacuum tuning

The default DDL sets aggressive autovacuum thresholds (`scale_factor=0.01`) to handle high-throughput OLTP workloads. Adjust via `ALTER TABLE` if needed.

---

## Examples

See the `university-app/` directory for a complete vertical-slice example application demonstrating:

- Command handlers with reducers (hire teacher, create course, enroll student, grade student)
- Tag-based stream queries
- Optimistic concurrency with `failIfEventsMatch`
- Projections for read models
- Fastify API routes

Run the example:

```bash
cd university-app
npm install
npm run typecheck
npm run test:unit
npm run test:integration  # requires Docker for PostgreSQL
```

---

## Design Documents

All design rationale and architecture decisions are in `.docs/`:

| File | Description |
|------|-------------|
| [`plan.md`](.docs/plan.md) | Original design: schema, query DSL, concurrency, streaming |
| [`dcb-tag-model-design.md`](.docs/dcb-tag-model-design.md) | DCB spec alignment: tags, queries, locks, compiler |
| [`architecture-review.md`](.docs/architecture-review.md) | Tech stack justification (TypeScript vs Rust/C, FFI analysis) |
| [`implementation-plan.md`](.docs/implementation-plan.md) | Task breakdown with test specs and status tracking |
| [`university-app-plan.md`](.docs/university-app-plan.md) | University domain: events, commands, business rules, API |
| [`projections-plan.md`](.docs/projections-plan.md) | Projections addon: loop design, gap-safety, API, schema |
| [`v2-migration.md`](.docs/v2-migration.md) | v1 → v2 API: `position`, `EmptyBatchError`, projection readiness |
| [`benchmarks.md`](.docs/benchmarks.md) | Baseline throughput, latency, and query-plan notes |

---

## OpenTelemetry (optional, opt-in)

By default the library does **not** use OpenTelemetry: omit `observability`, pass `{}`, or leave `enabled` unset/false — all use a local no-op and never load `@opentelemetry/api`.

To enable instrumentation, install `@opentelemetry/api` (optional peer), register an SDK in your app, and set:

```typescript
observability: { enabled: true }
```

You may also pass custom `tracer` / `meter` or `tracerProvider` / `meterProvider`. Scope name: **`es-dcb-library`** (package version). With `enabled: true`, **`append`** records `es_dcb.append` / `es_dcb.acquire_locks` spans and append metrics (event types and counts only — never payload, metadata, or tag values). Load/stream instrumentation follows in later PRs. For SQL-level traces, use `@opentelemetry/instrumentation-pg` in the application.

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Run unit tests (fast, no database)
npm run test:unit

# Run integration tests (requires Docker for PostgreSQL)
npm run test:integration

# Watch mode
npm run test:watch

# Build
npm run build  # Outputs ESM + CJS + .d.ts to dist/

# Operational benchmarks (Docker / testcontainers; not part of CI)
npm run bench
```

---

## License

[MIT](LICENSE) © Gabriel Schenker

---

## Contributing

1. Read the design docs in `.docs/`
2. Follow the Git flow in `CLAUDE.md` (branch per task, PR per feature, reviewer agent)
3. Ensure all tests pass before opening a PR
4. Add tests for new features

---

## Acknowledgements

This library implements the Dynamic Consistency Boundary pattern as specified at [dcb.events](https://dcb.events).
