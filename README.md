# es-dcb-library

A TypeScript event sourcing library implementing the **Dynamic Consistency Boundary (DCB)** pattern.

[![CI](https://github.com/gnschenker/es-dcb-library/actions/workflows/ci.yml/badge.svg)](https://github.com/gnschenker/es-dcb-library/actions/workflows/ci.yml)

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
const { version } = await store.load(orderQuery);

await store.append(
  [{ type: 'OrderShipped', data: { orderId, shippedAt: new Date().toISOString() } }],
  { failIfEventsMatch: orderQuery, after: version }
);
```

**Concurrency control:**  
The `failIfEventsMatch` condition checks whether any events matching the query exist after the specified `after` position. If they do, a `ConcurrencyError` is thrown. PostgreSQL advisory locks (acquired in sorted order by `(type, tag)` pairs) serialize concurrent writers, so `ConcurrencyError` indicates a true optimistic concurrency conflict, not lock contention.

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

console.log(result.events);    // StoredEvent[]
console.log(result.version);   // bigint (max global_position)
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

interface AppendCondition {
  failIfEventsMatch: Query;
  after?: bigint;  // fail if any matching event exists after this position
}
```

### EventStore Interface

```typescript
interface EventStore {
  append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<void>;
  load<D = Record<string, unknown>>(query: Query): Promise<LoadResult<D>>;
  stream<D = Record<string, unknown>>(query: Query, options?: StreamOptions): AsyncGenerator<StoredEvent<D>>;
  close(): Promise<void>;
}
```

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

For command handlers that load multiple streams, use `combineQueries` to merge them into a single query and version:

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

// Load all three streams with a single version
const allStreams = combineQueries(
  studentStream('s1'),
  courseStream('c1'),
  enrollmentStream('s1', 'c1')
);

const { events, version } = await store.load(allStreams);

// Filter events for each reducer
const studentEvents = events.filter(e => e.tags.includes('student:s1'));
const courseEvents = events.filter(e => e.tags.includes('course:c1'));
const enrollmentEvents = events.filter(e => 
  e.tags.includes('student:s1') && e.tags.includes('course:c1')
);

// Reduce state, make decision, append with single version
await store.append(newEvents, {
  failIfEventsMatch: allStreams,
  after: version,
});
```

**Why this matters**: Loading streams separately and picking `max(version1, version2, version3)` is error-prone. A single combined query ensures correct concurrency checking.

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

**Three ways to tag events**:
1. **Tag extractor**: Register a function for the event type
2. **Explicit tags**: Pass `tags: [...]` in the event (merged with extractor output)
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

const manager = new ProjectionManager(store, pool, [ordersProjection]);
await manager.initialize();
await manager.start();
```

**Key projection features:**
- **Catch-up + live processing**: Each projection runs in a loop that first catches up from `lastPos`, then listens for live events via `LISTEN/NOTIFY`.
- **Atomic handler + checkpoint**: Each event is processed in a transaction that includes both the handler logic and the checkpoint update. Handlers must be idempotent (`INSERT ... ON CONFLICT` or `UPDATE WHERE`).
- **Isolation**: Each projection runs independently. A slow or errored projection does not block others.
- **Gap-free guarantee**: The shared LISTEN client is started before any projection loop begins, ensuring no notifications are missed during catch-up.
- **Safe position protection**: Projections use `useSafePosition: true` to prevent skipping events when transactions commit out of order. See [Safe Position Design](./.docs/safe-position-design.md) for details.

### Projection Gap Safety

PostgreSQL's `BIGSERIAL` assigns `global_position` before commit, so transaction T1 (position 100) might commit after T2 (position 101). Without protection, a projection reading up to position 101 would permanently skip position 100.

**Solution**: Projections use the `useSafePosition: true` stream option, which computes a "safe position" using PostgreSQL's transaction visibility system (`xmin` + `txid_current_snapshot()`). Events are only processed up to the highest position where all earlier transactions have committed.

- **Performance**: Safe position queries are fast (~1ms) and do not require schema changes.
- **Latency**: Projections may lag by 10-100ms during high write concurrency, which is acceptable for most use cases.
- **No data loss**: Guaranteed event ordering with no gaps.

For full design rationale, see [`.docs/safe-position-design.md`](./.docs/safe-position-design.md).

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
  tags             TEXT[]       NOT NULL
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
```

---

## License

MIT

---

## Contributing

1. Read the design docs in `.docs/`
2. Follow the Git flow in `CLAUDE.md` (branch per task, PR per feature, reviewer agent)
3. Ensure all tests pass before opening a PR
4. Add tests for new features

---

## Acknowledgements

This library implements the Dynamic Consistency Boundary pattern as specified at [dcb.events](https://dcb.events).
