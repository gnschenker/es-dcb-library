# es-dcb-library

A TypeScript event sourcing library implementing the **Dynamic Context Boundaries (DCB)** pattern. Instead of traditional aggregates with fixed, pre-defined boundaries, context is defined dynamically at query time using a fluent DSL. The store is backed by PostgreSQL.

> **Status:** Under active development — see [`.docs/implementation-plan.md`](.docs/implementation-plan.md) for progress.

---

## What is DCB?

In classical event sourcing, an aggregate is a fixed stream of events identified by a single ID (e.g. `orderId`). The aggregate boundary is defined at design time and cannot change.

**Dynamic Context Boundaries** removes this constraint. A context is defined by a *query* — a set of event types and payload filters evaluated at runtime. The same event may belong to multiple overlapping contexts simultaneously, and the context for any given decision can be composed ad hoc.

```
Traditional:   load("order", orderId)  →  fixed stream for one aggregate
DCB:           load(query.eventsOfType('OrderCreated')
                         .where.key('orderId').equals('o1')
                         .eventsOfType('OrderShipped')
                         .where.key('orderId').equals('o1'))
               →  all events relevant to this decision, from any type
```

This makes it straightforward to handle decisions that cross what would traditionally be aggregate boundaries, without coupling aggregates together or introducing sagas for read-side consistency.

---

## Features

- **Fluent, immutable query DSL** — builds type-safe queries with no `.build()` call needed
- **Transactional append** with optimistic concurrency detection via PostgreSQL advisory locks
- **Keyset-pagination streaming** — `AsyncIterable<StoredEvent>` with no server-side cursors or long-lived transactions
- **Single PostgreSQL table** — simple schema, easy to inspect and migrate
- **Dual ESM + CJS output** — works in both `import` and `require` environments
- **No ORM** — raw parameterized SQL, full control over query shapes and indexes

---

## Requirements

- Node.js >= 18
- PostgreSQL >= 15
- Docker (for integration tests only)

---

## Installation

```bash
npm install es-dcb-library
```

---

## Quick Start

```typescript
import { PostgresEventStore, query, ConcurrencyError } from 'es-dcb-library';
import pg from 'pg';

// 1. Create a connection pool
const pool = new pg.Pool({ connectionString: 'postgres://user:pass@localhost:5432/mydb' });

// 2. Create the store
const store = new PostgresEventStore({ pool });

// 3. Create the table and indexes (safe to call repeatedly — idempotent)
await store.initializeSchema();

// 4. Append events
const [stored] = await store.append({
  type: 'OrderCreated',
  payload: { orderId: 'o1', customerId: 'c1', total: 99.99 },
  metadata: { correlationId: 'req-123' },
});

console.log(stored.globalPosition); // 1n (BigInt)
console.log(stored.eventId);        // UUID string

// 5. Load events
const q = query.eventsOfType('OrderCreated').where.key('orderId').equals('o1');
const { events, version } = await store.load(q);

// 6. Append with optimistic concurrency check
try {
  await store.append(
    { type: 'OrderShipped', payload: { orderId: 'o1' } },
    { query: q, expectedVersion: version },
  );
} catch (err) {
  if (err instanceof ConcurrencyError) {
    console.log(`Stale version: expected ${err.expectedVersion}, got ${err.actualVersion}`);
    // Re-read and retry
  }
}

// 7. Stream events
for await (const event of store.stream(q)) {
  console.log(event.type, event.payload);
}

// 8. Close the pool when done
await store.close();
```

---

## API

### `query`

The entry point for building queries. All builder methods are **immutable** — every call returns a new instance.

```typescript
import { query } from 'es-dcb-library';

// Single type, no filter
query.eventsOfType('OrderCreated')
query.allEventsOfType('OrderCreated')  // readable alias, identical behaviour

// Single type with payload filter
query.eventsOfType('OrderCreated')
  .where.key('customerId').equals('c1')

// AND filter — both conditions must match
query.eventsOfType('OrderCreated')
  .where.key('customerId').equals('c1')
  .and.key('region').equals('EU')

// OR filter — either condition matches
query.eventsOfType('OrderCreated')
  .where.key('status').equals('pending')
  .or.key('status').equals('active')

// Multi-type — returns events of both types in global_position order
query.eventsOfType('OrderCreated').where.key('orderId').equals('o1')
     .eventsOfType('OrderShipped').where.key('orderId').equals('o1')
```

`.where`, `.and`, and `.or` are **property getters** (not method calls) — they do not use `()`.

---

### `PostgresEventStore`

```typescript
const store = new PostgresEventStore({ pool: pg.Pool });
```

#### `initializeSchema(): Promise<void>`

Creates the `events` table and all required indexes. Safe to call on startup — uses `IF NOT EXISTS` throughout.

#### `load(query: QueryDefinition): Promise<LoadResult>`

Returns all matching events in ascending `global_position` order.

```typescript
interface LoadResult {
  events: StoredEvent[];
  version: bigint;  // MAX(global_position) of matched events, or 0n if none
}
```

`version` is designed to be passed directly as `expectedVersion` in the next `append` call.

#### `append(events, options?): Promise<StoredEvent[]>`

Appends one or more events in a single transaction. All events either commit or roll back together.

```typescript
// Without concurrency check
await store.append({ type: 'X', payload: { ... } });
await store.append([event1, event2, event3]);

// With optimistic concurrency check
const { version } = await store.load(q);
await store.append(newEvent, {
  query: q,               // scope of the conflict check
  expectedVersion: version,
  concurrencyQuery: q2,   // optional: use a different scope for the check only
});
```

Throws `ConcurrencyError` if:
- `expectedVersion` does not match the current `MAX(global_position)` for the query scope
- The advisory lock for the stream is held by a concurrent writer (transient — retry is appropriate)

#### `stream(query, options?): AsyncIterable<StoredEvent>`

Streams events using keyset pagination. Each page is a short independent query — no long-lived transactions.

```typescript
interface StreamOptions {
  batchSize?: number;      // rows per page (default: 100)
  afterPosition?: bigint;  // start after this global_position (default: 0n)
}

for await (const event of store.stream(q, { batchSize: 500 })) {
  await process(event);
}
```

Safe to `break` early — no connections are held between pages.

#### `close(): Promise<void>`

Drains and closes the connection pool. Call once on application shutdown.

---

### Types

```typescript
interface NewEvent<P = Record<string, unknown>> {
  type: string;
  payload: P;
  metadata?: Record<string, unknown>;
}

interface StoredEvent<P = Record<string, unknown>> {
  globalPosition: bigint;   // BIGSERIAL cast to BigInt — safe above 2^53
  eventId: string;          // UUID, generated by PostgreSQL
  type: string;
  payload: P;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}
```

`globalPosition` is always a `bigint`, never a `number`. This avoids precision loss for large stores.

---

### Errors

```typescript
import { ConcurrencyError, EventStoreError } from 'es-dcb-library';

// Thrown when expectedVersion !== actual MAX(global_position)
// or when the advisory lock is held by a concurrent writer
class ConcurrencyError extends Error {
  expectedVersion: bigint;
  actualVersion: bigint;
}

// Wraps unexpected database errors
class EventStoreError extends Error {
  cause?: unknown;
}
```

---

## Concurrency Model

`append()` with `AppendOptions` uses **PostgreSQL advisory locks** to serialise concurrent writers on the same logical stream. This is safer than a bare `SELECT MAX ... INSERT` sequence under `READ COMMITTED`, which has a lost-update race condition when two writers read the same version concurrently.

The lock key is derived from a canonical (deterministic, sorted) representation of the query, hashed with PostgreSQL's built-in `hashtext()`. The lock is transaction-scoped — released automatically on `COMMIT` or `ROLLBACK`. Unrelated streams are never blocked.

```
Writer A: lock(stream-key) ✓ → version check → insert → COMMIT → release
Writer B: lock(stream-key) ✗ → ConcurrencyError (retry with fresh load)
```

The `concurrencyQuery` option lets you decouple the load scope from the conflict-detection scope. For example, load a broad customer history but only detect conflicts on a specific order type:

```typescript
const broadQuery  = query.eventsOfType('OrderCreated').eventsOfType('OrderUpdated')
                         .where.key('customerId').equals('c1');
const narrowQuery = query.eventsOfType('OrderCreated').where.key('orderId').equals('o1');

const { events, version } = await store.load(broadQuery);
// ...
await store.append(newEvent, {
  query: broadQuery,
  expectedVersion: version,
  concurrencyQuery: narrowQuery,  // only conflict-check against order-specific events
});
```

---

## Database Schema

A single `events` table is created by `initializeSchema()`:

```sql
CREATE TABLE events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  payload          JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

Indexes created automatically:

| Index | Type | Purpose |
|-------|------|---------|
| `idx_events_type_position` | B-tree `(type, global_position)` | Type filter + ordered range queries |
| `idx_events_payload_gin` | GIN `(payload jsonb_path_ops)` | Payload containment (`@>`) queries |
| `idx_events_occurred_at_brin` | BRIN `(occurred_at)` | Time-bounded queries (tiny, near-zero write cost) |

Autovacuum thresholds are tightened at schema-init time (`scale_factor=0.01`) so dead tuples from rolled-back appends are reclaimed promptly.

---

## Development

```bash
npm install

npm run typecheck          # TypeScript strict check, no emit
npm run test:unit          # Unit tests — no database required
npm run test:integration   # Integration tests — requires Docker
npm run build              # Produces dist/ (ESM + CJS + .d.ts)
```

Integration tests spin up a PostgreSQL 15 container automatically via `testcontainers`. Docker must be running. The first run pulls the image; subsequent runs reuse it from cache.

Run a single test file:

```bash
npx vitest run tests/unit/query-builder.test.ts
```

See [`CLAUDE.md`](CLAUDE.md) for the full development workflow, Git flow, and architecture notes.

---

## Project Structure

```
src/
  index.ts              Public API barrel
  types.ts              NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore
  errors.ts             ConcurrencyError, EventStoreError
  query/
    types.ts            Internal: QueryDefinition, Clause, FilterNode
    builder.ts          ClauseBuilder, KeySelector, ValueSetter
    query-object.ts     Exported `query` singleton
    compiler.ts         QueryDefinition → parameterized SQL
  store/
    schema.ts           DDL + applySchema()
    row-mapper.ts       pg row → StoredEvent
    event-store.ts      PostgresEventStore

tests/
  unit/                 Pure unit tests — no database
  integration/          Tests against a real PostgreSQL instance

university-app/         Full example application (see below)
```

---

## Example Application — University Course Management

`university-app/` is a complete reference implementation built on top of `es-dcb-library`. It models a university course management system and demonstrates how DCB event sourcing handles real-world business rules without aggregates.

### What it models

| Domain concept | Description |
|---|---|
| **Teacher** | Hired and dismissed. Cannot be dismissed while assigned to an open course (BR-T4). |
| **Course** | Lifecycle: draft → open → closed / cancelled. Requires an assigned teacher to publish. |
| **Student** | Registered with a deterministic ID derived from email (UUID v5). |
| **Enrollment** | Students enroll in open courses, subject to capacity and prerequisite checks. Drop or withdraw before deadlines; graded by the course teacher when complete. |

Business rules span what would traditionally be multiple aggregates — for example, enrolling a student requires loading the student's completed-course history, the course's current enrollment count, and the student's existing enrollment state simultaneously. DCB handles this naturally: each command defines its own query context at runtime.

### Architecture

The app follows a **vertical slice** pattern — each command handler (`hire-teacher.ts`, `enroll-student.ts`, etc.) defines its own private stream queries and exported reducer functions. No shared state, no cross-slice imports. The Fastify HTTP layer is a thin wrapper that delegates entirely to the command handlers.

```
university-app/src/
  commands/          12 command handlers (one file per use-case)
  domain/            Event payload types, error classes, ID derivation, clock
  api/
    routes/          Fastify route registration (teachers, courses, students)
    middleware/      Error-to-HTTP-status mapping
  server.ts          Fastify factory (testable — accepts EventStore interface)
  index.ts           Entry point (DATABASE_URL, PORT from environment)
```

### Running with Docker Compose

The easiest way to run the university app is with Docker Compose, which starts PostgreSQL and the application together:

```bash
docker compose up --build
```

The API is then available at `http://localhost:3000/api/v1`.

### Manual smoke test

```bash
# Hire a teacher
curl -s -X POST http://localhost:3000/api/v1/teachers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dr. Smith","email":"smith@uni.edu","department":"CS"}' | jq .

# Create a course (use the teacherId from above)
curl -s -X POST http://localhost:3000/api/v1/courses \
  -H 'Content-Type: application/json' \
  -d '{"title":"Intro CS","semester":"Fall 2026","creditHours":3,"maxStudents":30,
       "prerequisites":[],"dropDeadline":"2026-09-15","withdrawalDeadline":"2026-10-15"}' | jq .

# Assign the teacher (replace :courseId and :teacherId)
curl -s -X PUT http://localhost:3000/api/v1/courses/:courseId/teacher \
  -H 'Content-Type: application/json' \
  -d '{"teacherId":":teacherId"}' | jq .

# Publish the course
curl -s -X POST http://localhost:3000/api/v1/courses/:courseId/publish | jq .

# Register a student
curl -s -X POST http://localhost:3000/api/v1/students \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@uni.edu","dateOfBirth":"2000-01-01"}' | jq .

# Enroll the student (replace :studentId)
curl -s -X POST http://localhost:3000/api/v1/courses/:courseId/enrollments \
  -H 'Content-Type: application/json' \
  -d '{"studentId":":studentId"}' | jq .

# Grade the student
curl -s -X POST http://localhost:3000/api/v1/courses/:courseId/enrollments/:studentId/grade \
  -H 'Content-Type: application/json' \
  -d '{"grade":88,"gradedBy":":teacherId"}' | jq .

# Check the student's course history
curl -s http://localhost:3000/api/v1/students/:studentId/courses | jq .
```

### Running locally (without Docker)

```bash
# From the repo root
cd university-app
npm install
npm run build

DATABASE_URL=postgres://user:pass@localhost:5432/university \
  npm start
```

### API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/teachers` | Hire a teacher |
| `POST` | `/api/v1/teachers/:id/dismiss` | Dismiss a teacher |
| `GET`  | `/api/v1/teachers/:id` | Get teacher state |
| `POST` | `/api/v1/courses` | Create a course |
| `PUT`  | `/api/v1/courses/:id/teacher` | Assign a teacher |
| `DELETE` | `/api/v1/courses/:id/teacher` | Remove the teacher |
| `POST` | `/api/v1/courses/:id/publish` | Publish a course |
| `POST` | `/api/v1/courses/:id/close` | Close a course |
| `POST` | `/api/v1/courses/:id/cancel` | Cancel a course |
| `GET`  | `/api/v1/courses/:id` | Get course state |
| `GET`  | `/api/v1/courses/:id/enrollments` | List enrollments |
| `POST` | `/api/v1/courses/:id/enrollments` | Enroll a student |
| `POST` | `/api/v1/courses/:id/enrollments/:studentId/unenroll` | Drop or withdraw |
| `POST` | `/api/v1/courses/:id/enrollments/:studentId/grade` | Grade a student |
| `POST` | `/api/v1/students` | Register a student |
| `GET`  | `/api/v1/students/:id` | Get student state |
| `GET`  | `/api/v1/students/:id/courses` | Get enrollment history |

### Tests

```bash
cd university-app

npm run test:unit          # 194 pure unit tests — no database needed
npm run test:integration   # 45 integration tests — spins up PostgreSQL via testcontainers
```

---

## License

MIT
