# Projections Extension for `es-dcb-library`

> **Status:** Draft — under review
>
> **Scope:** Addon subpath `es-dcb-library/projections`. The base library (`src/index.ts`) is never modified.
>
> **Pattern:** One projection per use case (Event Modelling style — no accidental coupling between slices). Background async population only; command handlers are never blocked by projection updates.
>
> **Compatibility:** Requires `moduleResolution: 'node16'` or `'bundler'` in consumer `tsconfig.json` for the `es-dcb-library/projections` subpath export to resolve correctly.

---

## 1. Purpose and Context

The existing library provides `store.load()` and `store.stream()` for reading events. In a CQRS / Event-Modelling application, every read endpoint currently replays its entire event stream on each HTTP request:

```
GET /courses/:courseId/enrollments
  → store.load(courseStream)                                      1 query
  → store.load(courseEnrollmentStream)                            1 query
  → for each student: store.load(enrollmentStream(studentId, courseId))  N queries
  = N + 2 queries per request
```

This is correct for **command handlers** (always need fresh, consistent state for the version check). It is expensive and unnecessary for **read endpoints** where eventual consistency is acceptable.

The projections extension provides a background mechanism that materialises pre-computed read models into PostgreSQL tables, kept up to date asynchronously as new events are appended.

### Design Principles
- **One projection per use case** — never share projections between vertical slices
- **Cheap to define** — 10–20 lines to define and wire a new projection
- **Fully async** — command handlers never wait for projection updates
- **Addon, not modification** — `src/index.ts` is never touched; import from `es-dcb-library/projections`
- **At-least-once delivery** — handlers must be idempotent; recommend `INSERT … ON CONFLICT DO UPDATE`

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  es-dcb-library (base — unchanged)                      │
│  ─ PostgresEventStore (stream, load, append)            │
│  ─ query DSL, StoredEvent, EventStore interface         │
└────────────────────────┬────────────────────────────────┘
                         │ uses stream()
┌────────────────────────▼────────────────────────────────┐
│  es-dcb-library/projections  (addon — new subpath)      │
│                                                         │
│  defineProjection()    — factory for projection defs    │
│  createEventDispatcher() — type-safe handler helper     │
│  ProjectionManager     — registers, runs, monitors      │
│    ├─ initialize()     — DDL + setup callbacks          │
│    ├─ start()          — spawns background loops        │
│    ├─ stop()           — graceful shutdown              │
│    ├─ waitUntilLive()  — startup sequencing helper      │
│    ├─ waitForPosition()— per-projection position wait   │
│    ├─ restart()        — recover projection from error  │
│    └─ getStatus()      — observable state snapshot      │
│                                                         │
│  Internal:                                              │
│    One shared LISTEN client (not one per projection)    │
│    Per-projection loop: catch-up → live                 │
└─────────────────────────────────────────────────────────┘
                         │ writes to
┌────────────────────────▼────────────────────────────────┐
│  PostgreSQL (same DB)                                   │
│  ─ events                  (existing, unchanged)        │
│  ─ projection_checkpoints  (new, managed by addon)      │
│  ─ read_*                  (user-defined, in setup())   │
└─────────────────────────────────────────────────────────┘
```

### ⚠️ Multi-instance warning

`ProjectionManager` is **not safe to run concurrently across multiple application instances**. Running the same projection on two nodes simultaneously leads to duplicate handler execution, undefined interleaving of read-model writes, and potential data corruption.

Options (operator's responsibility):
1. Run projections in a **dedicated worker process** (not in the API servers).
2. Use an **application-level leader election** so only one node starts the manager.
3. Use the built-in **PostgreSQL advisory lock** option (see `§3.3 singleInstance`).

---

## 3. Public API

### 3.1 `defineProjection()` — the primary author-facing API

```typescript
import { defineProjection } from 'es-dcb-library/projections';
import { query } from 'es-dcb-library';

export const teachersProjection = defineProjection({
  // Stable unique identifier — becomes the checkpoint row key.
  // Convention: lowercase, alphanumeric, hyphens/underscores only, max 128 chars.
  name: 'teachers-read-model',

  // Which event types drive this projection (standard query DSL).
  query: query
    .eventsOfType('TeacherHired')
    .eventsOfType('TeacherDismissed'),

  // Optional: create read table(s). Called once during initialize(). Must be idempotent.
  // IMPORTANT: Only put CREATE TABLE IF NOT EXISTS here.
  // Index creation (especially CONCURRENTLY) should be done outside setup() or
  // carefully timed to avoid blocking startup.
  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS read_teachers (
        teacher_id   TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        email        TEXT NOT NULL,
        department   TEXT NOT NULL,
        status       TEXT NOT NULL,
        hired_at     TIMESTAMPTZ NOT NULL,
        dismissed_at TIMESTAMPTZ
      )
    `);
  },

  // Called once per matching event, inside an open transaction.
  // Checkpoint update is committed in the same transaction — atomically.
  // MUST BE IDEMPOTENT — at-least-once delivery; use ON CONFLICT DO UPDATE.
  async handler(event, client) {
    if (event.type === 'TeacherHired') {
      const p = event.payload as TeacherHiredPayload;
      await client.query(
        `INSERT INTO read_teachers (teacher_id, name, email, department, status, hired_at)
         VALUES ($1, $2, $3, $4, 'hired', $5)
         ON CONFLICT (teacher_id) DO UPDATE SET
           name=$2, email=$3, department=$4, status='hired', hired_at=$5, dismissed_at=NULL`,
        [p.teacherId, p.name, p.email, p.department, p.hiredAt],
      );
    }
    if (event.type === 'TeacherDismissed') {
      const p = event.payload as TeacherDismissedPayload;
      await client.query(
        `UPDATE read_teachers SET status='dismissed', dismissed_at=$1 WHERE teacher_id=$2`,
        [p.dismissedAt, p.teacherId],
      );
    }
  },
});
```

### 3.2 `createEventDispatcher()` — type-safe handler helper

Avoids string-indexed `event.payload['field']` patterns by providing typed dispatch:

```typescript
import { createEventDispatcher } from 'es-dcb-library/projections';

const teachersProjection = defineProjection({
  name: 'teachers-read-model',
  query: query.eventsOfType('TeacherHired').eventsOfType('TeacherDismissed'),
  setup: ...,

  handler: createEventDispatcher({
    TeacherHired: async (payload: TeacherHiredPayload, _event, client) => {
      await client.query(`INSERT INTO read_teachers ...`, [...]);
    },
    TeacherDismissed: async (payload: TeacherDismissedPayload, _event, client) => {
      await client.query(`UPDATE read_teachers ...`, [...]);
    },
    // Events not listed here are silently ignored
  }),
});
```

Types (`src/projections/types.ts`):

```typescript
export type DispatchHandlers = {
  [eventType: string]: (
    payload: Record<string, unknown>,
    event: StoredEvent,
    client: pg.PoolClient,
  ) => Promise<void>;
};

export function createEventDispatcher(handlers: DispatchHandlers): ProjectionHandler;
// Returns: async (event, client) => { const h = handlers[event.type]; if (h) await h(event.payload, event, client); }
```

### 3.3 Types (`src/projections/types.ts`)

```typescript
import type pg from 'pg';
import type { QueryDefinition } from '../query/types.js';
import type { StoredEvent } from '../types.js';

/** Called inside an open transaction. Must NOT call BEGIN/COMMIT/ROLLBACK. */
export type ProjectionHandler = (
  event: StoredEvent,
  client: pg.PoolClient,
) => Promise<void>;

/**
 * Called once during initialize(). Must use IF NOT EXISTS / idempotent DDL.
 * Only CREATE TABLE IF NOT EXISTS — avoid slow DDL (indexes, ALTER TABLE).
 */
export type ProjectionSetup = (client: pg.PoolClient) => Promise<void>;

export interface ProjectionDefinition {
  /** Stable unique identifier. Convention: /^[a-zA-Z][a-zA-Z0-9\-_]{0,127}$/ */
  readonly name: string;
  /** Which event types drive this projection. Must have at least one clause. */
  readonly query: QueryDefinition;
  readonly setup?: ProjectionSetup;
  readonly handler: ProjectionHandler;
}

/**
 * Validates the definition and returns it typed.
 * Throws if name is empty/whitespace or does not match naming convention,
 * or if query._clauses is empty.
 */
export function defineProjection(def: ProjectionDefinition): ProjectionDefinition;
```

### 3.4 `ProjectionManager` (`src/projections/manager.ts`)

```typescript
export interface ProjectionManagerConfig {
  pool: pg.Pool;               // For read-model writes + checkpoints
  store: EventStore;           // From base library — provides stream()
  projections: ProjectionDefinition[];

  /**
   * Called when a projection enters 'error' state (all retries exhausted).
   * Wrapped in try-catch inside the manager — a throwing onError is swallowed.
   * Default: logs to stderr.
   */
  onError?: (projectionName: string, error: unknown) => void;

  /**
   * Called on each retry attempt before the delay.
   * Useful for metrics / alerting on first failure, before final death.
   */
  onRetry?: (projectionName: string, attempt: number, error: unknown, nextDelayMs: number) => void;

  /**
   * Called on every projection status transition.
   * Useful for emitting metrics or health signals.
   */
  onStatusChange?: (
    projectionName: string,
    oldStatus: ProjectionStatus,
    newStatus: ProjectionStatus,
  ) => void;

  /**
   * Max retries for handler-level errors (bad SQL, constraint violations).
   * Uses linear backoff: retryDelayMs × attempt.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Base delay between handler retries in ms. Linear: delay × attemptNumber.
   * Default: 500ms. Max total wait ≈ maxRetries × (maxRetries+1)/2 × retryDelayMs.
   */
  retryDelayMs?: number;

  /**
   * Batch size used for store.stream() in both catch-up and live phases.
   * Default: 200
   */
  streamBatchSize?: number;

  /**
   * Fallback polling interval when no NOTIFY arrives.
   * Also closes the NOTIFY gap between catch-up and live phase.
   * Default: 5000ms
   */
  pollIntervalMs?: number;

  /**
   * Max time allowed for a single projection's setup() call.
   * Prevents a hung DDL statement from blocking initialize() indefinitely.
   * Default: 30000ms
   */
  setupTimeoutMs?: number;

  /**
   * If true, acquire a PostgreSQL session-level advisory lock per projection
   * name before starting its loop. A node that cannot acquire the lock
   * skips that projection (it is already running elsewhere).
   * Provides basic protection against concurrent multi-instance execution.
   * Requires a direct connection per projection (not a pool connection).
   * Default: false
   */
  singleInstance?: boolean;

  /**
   * If true, handlers are called but no database writes are performed
   * (no BEGIN/COMMIT, no checkpoint update). Useful for testing handler logic
   * without side effects or for validating a new projection against production data.
   * Default: false
   */
  dryRun?: boolean;
}

export type ProjectionStatus = 'pending' | 'catching-up' | 'live' | 'error' | 'stopped';

export interface ProjectionState {
  name: string;
  status: ProjectionStatus;
  lastProcessedPosition: bigint;
  lastUpdatedAt: Date | null;  // From projection_checkpoints.updated_at; null if never processed
  errorDetail?: unknown;
}

export class ProjectionManager {
  constructor(config: ProjectionManagerConfig);

  /**
   * Creates/updates projection schema (idempotent — safe to call on every startup).
   * Calls setup() for each projection that defines one, subject to setupTimeoutMs.
   * Inserts initial checkpoint rows (ON CONFLICT DO NOTHING).
   * Must be called before start().
   */
  initialize(): Promise<void>;

  /**
   * Spawns a background loop for each projection. Returns immediately.
   * Safe to call only once per manager instance.
   */
  start(): void;

  /**
   * Resolves when all projections have completed catch-up and are 'live' (or 'error').
   * Useful for blocking HTTP server startup until read models are populated.
   * Rejects if timeoutMs elapses before all projections are live.
   * Default timeoutMs: 60000ms
   */
  waitUntilLive(timeoutMs?: number): Promise<void>;

  /**
   * Resolves when the named projection has processed at least targetPosition.
   * Polls projection_checkpoints every 50ms.
   * Rejects if timeoutMs elapses.
   * Default timeoutMs: 5000ms
   */
  waitForPosition(projectionName: string, targetPosition: bigint, timeoutMs?: number): Promise<void>;

  /**
   * Restart a projection that is in 'error' state.
   * Re-reads the checkpoint from the DB (does not trust in-memory lastPos).
   * Clears errorDetail and spawns a new loop.
   * No-op if the projection is not in 'error' state.
   */
  restart(projectionName: string): Promise<void>;

  /**
   * Signals all loops to stop. Awaits in-flight handler transactions to complete.
   * Releases the shared LISTEN client. Resolves when all loops have exited.
   */
  stop(): Promise<void>;

  /** Snapshot of current projection statuses. */
  getStatus(): ProjectionState[];
}
```

---

## 4. PostgreSQL Schema (New Objects)

### 4.1 Checkpoint table

```sql
CREATE TABLE IF NOT EXISTS projection_checkpoints (
  name          TEXT        PRIMARY KEY,
  last_position BIGINT      NULL,           -- NULL = never processed; 0 is not a valid event position
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- `last_position = NULL` → never processed; catch-up starts with `afterPosition: 0n`
- `last_position > 0` → position of last successfully committed event
- Row inserted during `initialize()` with `ON CONFLICT (name) DO NOTHING` — safe on restart
- `updated_at` provides observability: "how stale is this projection"

### 4.2 NOTIFY trigger on `events` table

```sql
-- One notification per INSERT statement (not per row).
-- Eliminates thundering herd when store.append() inserts multiple events.
CREATE OR REPLACE FUNCTION es_notify_event_inserted()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('es_events', '');
  RETURN NULL;   -- Statement-level triggers must return NULL
END;
$$;

CREATE OR REPLACE TRIGGER trg_es_events_notify
AFTER INSERT ON events
FOR EACH STATEMENT EXECUTE FUNCTION es_notify_event_inserted();
```

Key properties:
- **Statement-level** (`FOR EACH STATEMENT`) — one NOTIFY per `store.append()` call regardless of how many events are inserted. This prevents thundering herd (N rows → N NOTIFYs → N×projections wakeups).
- **Empty payload** — each loop always re-streams from its `lastPos` anyway; carrying position in the payload buys nothing and complicates the function.
- `pg_notify` fires inside the inserting transaction; listener sees it only after `COMMIT` → no notifications for rolled-back appends.
- `CREATE OR REPLACE` makes DDL idempotent — safe on every startup.
- Channel name `'es_events'` is an unexported internal constant.

> **⚠️ PgBouncer / connection pooler compatibility:** LISTEN requires a persistent, stateful connection. PgBouncer in transaction-pooling or statement-pooling mode does not support LISTEN. The shared LISTEN client (see §5.1) must connect directly to PostgreSQL or via a session-mode pooler. Document this constraint prominently in `ProjectionManagerConfig`.

### 4.3 `applyProjectionSchema(client)`

Mirrors `applySchema()` in `src/store/schema.ts`:

```typescript
// src/projections/schema.ts
export async function applyProjectionSchema(client: pg.ClientBase): Promise<void> {
  await client.query(DDL_CREATE_CHECKPOINTS_TABLE);
  await client.query(DDL_CREATE_NOTIFY_FUNCTION);
  await client.query(DDL_CREATE_NOTIFY_TRIGGER);
}
```

Not exported from the public barrel — called internally by `ProjectionManager.initialize()`.

---

## 5. Internal Loop Design

### 5.1 Shared LISTEN client (one for all projections)

Rather than one dedicated `pg.Client` per projection, the manager creates a **single shared LISTEN client** that fans out notifications to all projection loops. This:
- Reduces extra connections to exactly 1 regardless of projection count.
- Avoids pool exhaustion (`pool.max` must only account for handler concurrency, not LISTEN connections).
- Centralises reconnection logic in one place.

The shared LISTEN client is a `new pg.Client(connectionString)` — a direct connection, not a pool client — for the reasons below.

**Why not a pool client?** Pool connections lose LISTEN subscriptions when returned to the pool. PgBouncer in non-session mode does not support LISTEN at all. A dedicated `pg.Client` is the only correct choice.

**Connection pool sizing guidance** (document in `ProjectionManagerConfig` JSDoc):
- The shared LISTEN client uses 1 extra connection.
- Each projection's `processEvent` acquires a pool connection transiently.
- With N projections processing events concurrently: `pool.max >= N + app_concurrency + 2`.
- For the typical case (< 10 projections, < 20 app connections): `pool.max = 30` is a safe default.

### 5.2 Per-projection async loop

```
─── INITIALIZATION ─────────────────────────────────────────
  read checkpoint row: SELECT last_position, updated_at FROM projection_checkpoints WHERE name=$1
  state.lastPos = row.last_position != null ? BigInt(row.last_position) : 0n
  state.status = 'pending'   ← initial state before start() is called

─── PHASE 1: CATCH-UP ─────────────────────────────────────
  state.status = 'catching-up'   [triggers onStatusChange]
  for await event of store.stream(query, { afterPosition: lastPos, batchSize: streamBatchSize }):
    if stopRequested: break
    processEventWithRetry(event)
    state.lastPos = event.globalPosition

─── TRANSITION TO LIVE (gap-free) ─────────────────────────
  // LISTEN is already established by the shared client (before loops start)
  // Do one unconditional drain to close the gap between last catch-up read and now:
  for await event of store.stream(query, { afterPosition: lastPos, batchSize: streamBatchSize }):
    if stopRequested: break
    processEventWithRetry(event)
    state.lastPos = event.globalPosition
  state.status = 'live'   [triggers onStatusChange]

─── PHASE 2: LIVE ──────────────────────────────────────────
  while not stopRequested:
    await waitForNotifyOrTimeout(sharedNotifySignal, pollIntervalMs, stopSignal)
    if stopRequested: break
    for await event of store.stream(query, { afterPosition: lastPos, batchSize: streamBatchSize }):
      if stopRequested: break
      processEventWithRetry(event)
      state.lastPos = event.globalPosition

─── SHUTDOWN ───────────────────────────────────────────────
  state.status = 'stopped'   [triggers onStatusChange]
```

### 5.3 Gap-free catch-up → live transition (corrected)

The naive approach — complete catch-up, then start LISTEN — has a race window:

1. Catch-up reads last batch, observes `lastPos = N`.
2. An event at position `N+1` is appended and committed. Its NOTIFY fires.
3. `LISTEN` is established. The notification for `N+1` is already gone.
4. The next NOTIFY (for `N+2`) wakes the live loop, which drains from `N` and picks up `N+1` and `N+2`. But if no further events arrive, `N+1` is not processed until the poll timeout.

**Correct approach:**
1. The shared LISTEN client starts `LISTEN es_events` during `initialize()`, **before any loops start**.
2. Each projection completes catch-up normally.
3. After the catch-up loop exits, do **one unconditional drain** (`store.stream(afterPosition: lastPos)`) — this picks up any events that arrived during catch-up.
4. Only then enter the `waitForNotifyOrTimeout` loop.

This guarantees convergence: no event can be missed.

### 5.4 Shared LISTEN client reconnection

The shared LISTEN client must handle disconnects:

```typescript
// Internal manager logic (pseudocode)

function createListenClient(connectionString: string, onNotify: () => void): ManagedListenClient {
  let client: pg.Client;
  let reconnectDelay = 1000; // ms, doubles on each failure up to maxReconnectDelay
  const maxReconnectDelay = 60_000;

  async function connect() {
    client = new pg.Client({ connectionString });
    client.on('error', (err) => {
      console.error('[projections] LISTEN client error:', err);
      scheduleReconnect();
    });
    client.on('end', () => {
      scheduleReconnect();
    });
    client.on('notification', () => {
      onNotify();          // fan-out signal to all projection loops
      reconnectDelay = 1000; // reset on successful notification
    });
    await client.connect();
    await client.query("LISTEN es_events");
    reconnectDelay = 1000;
  }

  function scheduleReconnect() {
    // After disconnect: trigger all loops to re-drain via the notify signal
    // then reconnect the LISTEN client
    onNotify();  // wake loops to catch up via polling while reconnecting
    setTimeout(async () => {
      try {
        await connect();
      } catch {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        scheduleReconnect();
      }
    }, reconnectDelay);
  }

  return { connect, end: () => client.end() };
}
```

After a reconnect, each loop picks up any events that arrived during the disconnect via its next `store.stream(afterPosition: lastPos)` drain (triggered by the `onNotify()` call in `scheduleReconnect`).

### 5.5 Atomic handler + checkpoint (per event)

```typescript
// processEvent(def, event, pool, dryRun)
if (dryRun) {
  // Call handler in a real transaction so SQL can be validated, but roll back
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await def.handler(event, client);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  return;
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  await def.handler(event, client);           // user writes read-model rows
  await client.query(
    'UPDATE projection_checkpoints SET last_position=$1, updated_at=NOW() WHERE name=$2',
    [event.globalPosition, def.name],
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  client.release();
}
```

- Crash after COMMIT → checkpoint advanced → event not replayed ✓
- Crash before COMMIT → both rolled back → event replayed
- **Handlers must be idempotent** — use `INSERT … ON CONFLICT DO UPDATE` for all read-model writes

### 5.6 Retry + error state

```
maxRetries=3, retryDelayMs=500, linear: delay × attempt (500ms, 1000ms, 1500ms)

attempt loop:
  try processEvent → success: return
  catch err:
    attempt++
    nextDelay = retryDelayMs * attempt
    try { onRetry(name, attempt, err, nextDelay); } catch { /* swallow */ }
    if attempt > maxRetries:
      state.status = 'error'
      state.errorDetail = err
      try { onError(name, err); } catch { /* swallow — never propagate */ }
      throw  ← terminates this loop only; other loops continue
    await sleep(nextDelay)
```

### 5.7 Graceful shutdown

```typescript
// ProjectionManager.stop()
for each loopState: { loopState.stopRequested = true; loopState.stopSignal(); }
await Promise.allSettled(loopPromises);  // allSettled — crashed loop does not block others
await listenClient.end();
```

`waitForNotifyOrTimeout` resolves immediately on `stopSignal()`. In-flight transactions complete (commit or rollback) before the loop exits.

### 5.8 Status state machine

```
         initialize()           start()
[─────────] ──────────► [pending] ──────────► [catching-up]
                                                     │
                                    catch-up done + drain
                                                     │
                                                     ▼
                                                  [live]
                                                 ╱      ╲
                            maxRetries exhausted          stop() called
                                   ╱                              ╲
                               [error]                        [stopped]
                                  │
                            restart() called
                                  │
                                  ▼
                            [catching-up]
```

---

## 6. File Structure

```
src/projections/
  types.ts     defineProjection(), createEventDispatcher(), all public types
  schema.ts    DDL string constants + applyProjectionSchema(client)
  loop.ts      Internal: processEvent, runCatchUp, runLive, runProjectionLoop
  manager.ts   ProjectionManager class + ManagedListenClient
  index.ts     Public barrel

tests/unit/
  projections-define.test.ts      (no database)
  projections-schema.test.ts      (no database)

tests/integration/
  projections-schema.test.ts      (real PostgreSQL)
  projections-catchup.test.ts
  projections-live.test.ts
  projections-error.test.ts
```

### `src/projections/index.ts` — public exports only

```typescript
export { defineProjection, createEventDispatcher } from './types.js';
export type { ProjectionDefinition, ProjectionHandler, ProjectionSetup, DispatchHandlers } from './types.js';
export { ProjectionManager } from './manager.js';
export type { ProjectionManagerConfig, ProjectionStatus, ProjectionState } from './manager.js';
// applyProjectionSchema NOT exported — internal, managed by ProjectionManager
```

---

## 7. Build / Package Integration

### `tsup.config.ts` — one line change

```typescript
// Before:
entry: ['src/index.ts'],

// After:
entry: ['src/index.ts', 'src/projections/index.ts'],
// All other options unchanged (splitting: false, format: ['esm', 'cjs'], dts: true, ...)
```

Produces: `dist/projections/index.js`, `dist/projections/index.cjs`, `.d.ts`/`.d.cts`.

### `package.json` — add `"./projections"` subpath export

```json
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts",              "default": "./dist/index.js"  },
    "require": { "types": "./dist/index.d.cts",            "default": "./dist/index.cjs" }
  },
  "./projections": {
    "import": { "types": "./dist/projections/index.d.ts",  "default": "./dist/projections/index.js"  },
    "require": { "types": "./dist/projections/index.d.cts","default": "./dist/projections/index.cjs" }
  }
}
```

> **Consumer tsconfig requirement:** The `./projections` subpath resolves correctly only with `"moduleResolution": "node16"` or `"bundler"`. Classic `"node"` resolution does not support package subpath exports.

`import { PostgresEventStore } from 'es-dcb-library'` continues to work unchanged.

---

## 8. Testing Strategy

### Unit tests (no database)

**`tests/unit/projections-define.test.ts`**
- `defineProjection` returns definition unchanged when valid
- Throws when `name` is empty / whitespace-only
- Throws when `name` does not match naming convention (e.g. too long, invalid chars)
- Throws when `query._clauses` is empty
- Accepts definition without `setup`
- `createEventDispatcher` returns a `ProjectionHandler` function
- `createEventDispatcher` calls the correct sub-handler for a matching event type
- `createEventDispatcher` silently skips events with no matching handler

**`tests/unit/projections-schema.test.ts`**
- `DDL_CREATE_CHECKPOINTS_TABLE` contains `IF NOT EXISTS`
- `DDL_CREATE_CHECKPOINTS_TABLE` has `PRIMARY KEY` on `name`
- `DDL_CREATE_CHECKPOINTS_TABLE` declares `last_position BIGINT NULL` (not `DEFAULT 0`)
- `DDL_CREATE_NOTIFY_TRIGGER` contains `FOR EACH STATEMENT` (not `FOR EACH ROW`)
- `DDL_CREATE_NOTIFY_TRIGGER` references `trg_es_events_notify`
- `DDL_CREATE_NOTIFY_FUNCTION` contains `CREATE OR REPLACE`

### Integration tests (real PostgreSQL, reuse existing testcontainers setup)

**`tests/integration/projections-schema.test.ts`**
- `applyProjectionSchema()` is idempotent (safe to call twice)
- `projection_checkpoints` table exists with correct nullable `last_position`
- NOTIFY trigger fires once per `store.append()` call (even when appending multiple events — verify it does NOT fire N times for N events)
- NOTIFY received by LISTEN client within 500 ms of `store.append()`

**`tests/integration/projections-catchup.test.ts`**
- Processes all pre-existing matching events from position 0
- Skips events not matching the projection's query
- Checkpoint equals last processed `globalPosition` and is not NULL
- Does not reprocess events already in checkpoint on restart
- Atomicity: handler throws after writing → both read-model row and checkpoint absent (both rolled back)
- `dryRun: true` — handler is called but read-model rows and checkpoint are absent

**`tests/integration/projections-live.test.ts`**
- New event appended after catch-up → projection processes it, checkpoint advances
- Multiple events appended in one `store.append([...])` call → all processed, only one NOTIFY received
- Gap-free transition: event appended between catch-up end and live start is not missed
- `stop()` completes within 2 s, no leaked connections
- `waitUntilLive()` resolves after all projections are live
- `waitForPosition()` resolves once projection reaches the target position

**`tests/integration/projections-error.test.ts`**
- Handler throws on first 2 attempts; succeeds on 3rd → `onRetry` called twice, projection recovers
- `maxRetries` exhaustion → `onError` called, projection enters `'error'` state
- `onError` that itself throws does not crash the process
- Other projections continue unaffected when one enters `'error'`
- `restart()` re-reads checkpoint from DB and starts a new loop; projection returns to 'live'

### New integration test helpers

```typescript
// Additions to tests/integration/helpers.ts

export async function resetProjectionSchema(pool: pg.Pool): Promise<void>;
// Calls applyProjectionSchema and then TRUNCATE projection_checkpoints

/**
 * Polls projection_checkpoints every 50ms until last_position >= targetPosition.
 * Tests should generally assert the read-model content directly;
 * use this as a precondition guard, not as the primary assertion.
 */
export async function waitForProjectionPosition(
  pool: pg.Pool,
  projectionName: string,
  targetPosition: bigint,
  timeoutMs?: number,   // default 5000ms
): Promise<void>;
```

---

## 9. University-App Example (before / after)

### Before — event replay on every request

```typescript
// GET /teachers/:teacherId — currently in routes/teachers.ts
const { events } = await store.load(teacherStream(teacherId)); // query per request
const state = reduceTeacherForRead(events);                    // fold in-process
```

`GET /courses/:courseId/enrollments` with N students: **N + 2 queries per request**.

### After — projection-backed read model

```typescript
// university-app/src/projections/teachers-read-model.ts
export const teachersProjection = defineProjection({
  name: 'teachers-read-model',
  query: query.eventsOfType('TeacherHired').eventsOfType('TeacherDismissed'),
  setup: async (client) => { await client.query(`CREATE TABLE IF NOT EXISTS read_teachers (...)`); },
  handler: createEventDispatcher({
    TeacherHired: async (p: TeacherHiredPayload, _ev, client) => { /* UPSERT */ },
    TeacherDismissed: async (p: TeacherDismissedPayload, _ev, client) => { /* UPDATE */ },
  }),
});

// university-app/src/index.ts
const manager = new ProjectionManager({
  pool: readPool,
  store,
  projections: [teachersProjection],
  onError: (name, err) => console.error(`Projection "${name}" failed:`, err),
});
await store.initializeSchema();
await manager.initialize();
manager.start();
await manager.waitUntilLive();  // Block HTTP startup until read models populated
app.listen(port);
process.on('SIGTERM', () => manager.stop());

// GET /teachers/:teacherId — O(1) indexed SELECT
const result = await readPool.query(
  'SELECT * FROM read_teachers WHERE teacher_id = $1', [teacherId],
);
```

| Metric | Before | After |
|--------|--------|-------|
| DB queries per GET | 1 `store.load()` (1–N SQL) | 1 point SELECT |
| GET /enrollments (30 students) | 32 queries | 1 query |
| Staleness | Strongly consistent | Eventual (NOTIFY latency, typically < 10 ms) |
| Business logic in GET handler | Reducer inline | None |

---

## 10. Implementation Tasks

Each task follows the same Git flow as the base library (`task/P-XX-*` branch, `feat: P-XX` PR, reviewer agent).

### Task Index

| ID | Title | Depends on |
|----|-------|-----------|
| P-01 | Write `.docs/projections-plan.md` to repository | — |
| P-02 | Schema — DDL constants + `applyProjectionSchema()` | P-01 |
| P-03 | Public types — `defineProjection()`, `createEventDispatcher()`, all type interfaces | P-01 |
| P-04 | Internal `processEvent` — atomic handler + checkpoint + dryRun mode | P-02, P-03 |
| P-05 | Internal `runCatchUp` — stream + checkpoint loop | P-04 |
| P-06 | Internal `runLive` — shared LISTEN client + fan-out + poll fallback + reconnect | P-05 |
| P-07 | `ProjectionManager` — initialize, start, stop, waitUntilLive, waitForPosition, restart, getStatus | P-06 |
| P-08 | Build integration — `tsup.config.ts` + `package.json` subpath export | P-07 |
| P-09 | Unit tests — `defineProjection`, `createEventDispatcher`, DDL constants | P-02, P-03 |
| P-10 | Integration tests — schema + trigger (FOR EACH STATEMENT, single NOTIFY per append) | P-02 |
| P-11 | Integration tests — catch-up correctness + atomicity + dryRun | P-04, P-05, P-10 |
| P-12 | Integration tests — live phase + gap-free transition + stop + waitUntilLive | P-06, P-07, P-11 |
| P-13 | Integration tests — error handling + retry + restart() | P-07, P-11 |
| P-14 | University-app example — teachers read model | P-08 |

### Dependency graph

```
P-01
├── P-02 ─────────────────────┐
│     └── P-04                │
│           └── P-05          │
│                 └── P-06    │
│                      └── P-07 ─── P-08 ─── P-14
└── P-03 ─────┘

P-09  ← P-02, P-03
P-10  ← P-02
P-11  ← P-04, P-05, P-10
P-12  ← P-06, P-07, P-11
P-13  ← P-07, P-11
```

After P-01: **P-02 and P-03 can start in parallel**.
After P-08: **P-09 and P-10 can start in parallel**.

---

## 11. Key Design Decisions and Rationale

| Decision | Rationale |
|----------|-----------|
| Single shared LISTEN client (not one per projection) | Reduces extra connections from N to 1; centralises reconnect logic; prevents pool exhaustion |
| LISTEN established before loops start (in initialize) | Closes the gap-free race window between catch-up end and live start |
| Unconditional drain after catch-up before entering notify loop | Guarantees no event is missed in the window after LISTEN is set up |
| Statement-level trigger (FOR EACH STATEMENT) | One NOTIFY per append call regardless of batch size; prevents thundering herd with N projections |
| Empty NOTIFY payload | Loop always re-streams from lastPos anyway; payload position optimisation buys nothing; simpler DDL |
| `last_position BIGINT NULL` (not DEFAULT 0) | NULL = "never run" is semantically distinct from a real position; enables explicit reset flows |
| Dedicated `pg.Client` for LISTEN (not pool) | Pool connections lose LISTEN state when returned; PgBouncer transaction mode incompatible with LISTEN |
| Reconnect with exponential backoff on LISTEN disconnect | LISTEN client can drop (network, server restart, RDS); silence here = silent projection lag |
| Handler idempotency is user's responsibility (documented) | Library cannot know read-model semantics; document prominently, recommend ON CONFLICT DO UPDATE |
| `waitUntilLive()` on manager | Without it, API server starts serving stale read models on first deploy; simple polling loop |
| `restart()` on manager | Production systems need to recover individual projections without process restart |
| `createEventDispatcher()` helper | Eliminates string-indexed `event.payload['field']` patterns; improves type safety |
| `dryRun` mode | Enables testing handler SQL and validating new projections against production data safely |
| `onError` + `onRetry` + `onStatusChange` callbacks | Complete observability coverage from first failure to final death; all wrapped in try-catch |
| `singleInstance` advisory lock option | Basic multi-instance safety without external coordination infrastructure |
| Linear retry backoff for handler errors | Bounded delay; exponential not appropriate when events arrive faster than handler processes |
| `Promise.allSettled` in `stop()` | Crashed loop does not block shutdown of healthy loops |
| Per-projection loops, not a shared loop | Isolation: slow or errored projection does not delay others |
| No projection versioning / migrations (v1) | Significant added complexity; user resets checkpoint + drops table to rebuild |

---

## 12. Out of Scope (Future Iterations)

- Projection schema versioning and automatic migrations
- Cross-database projections
- Snapshotting (skip replaying old events by loading a snapshot)
- Real-time push to clients (WebSockets / SSE)
- Read-side query / repository abstraction
- Distributed multi-node leader election (beyond the basic `singleInstance` advisory lock)
- Projection replay from a specific start position (partial rebuilds)
