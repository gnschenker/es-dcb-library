# Plan: es-dcb-library — Event Sourcing Library with Dynamic Context Boundaries

## Context
Build a library for event sourcing using the DCB (Dynamic Context Boundaries) pattern. Instead of aggregates, context is defined dynamically by queries at runtime. The library provides a PostgreSQL-backed event store with a readable query builder DSL, transactional append with optimistic concurrency detection, and cursor-based streaming for large event sets. MVP excludes aggregates.

---

## Module Structure

```
es-dcb-library/
├── src/
│   ├── index             # Public API — all exports
│   ├── types             # Core domain types: NewEvent, StoredEvent, LoadResult, AppendOptions, EventStore, StreamOptions
│   ├── errors            # ConcurrencyError, EventStoreError
│   ├── query/
│   │   ├── types         # Internal: QueryDefinition, Clause, FilterNode
│   │   ├── builder       # ClauseBuilder, KeySelector, ValueSetter
│   │   ├── query-object  # Top-level `query` singleton export
│   │   └── compiler      # QueryDefinition → parameterized SQL
│   └── store/
│       ├── event-store   # PostgresEventStore: load, append, stream, initializeSchema
│       ├── schema        # SQL DDL
│       └── row-mapper    # DB row → StoredEvent
├── tests/
│   ├── unit/
│   │   ├── query-builder # DSL chain logic, immutability
│   │   └── query-compiler# SQL output correctness
│   └── integration/
│       ├── setup         # Test DB bootstrapping
│       ├── event-store   # append, load, concurrency, filters
│       └── streaming     # cursor-based stream()
└── [build/config files TBD with tech stack]
```

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS events (
  global_position  BIGSERIAL    PRIMARY KEY,
  event_id         UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  type             VARCHAR(255) NOT NULL,
  payload          JSONB        NOT NULL,
  metadata         JSONB,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- GIN index on payload (jsonb_path_ops supports @> containment, smaller/faster than jsonb_ops)
CREATE INDEX IF NOT EXISTS idx_events_payload_gin
  ON events USING GIN (payload jsonb_path_ops);

-- B-tree on type for equality filter
CREATE INDEX IF NOT EXISTS idx_events_type
  ON events (type);

-- Composite for ordered range queries: WHERE type = $1 AND global_position > $N ORDER BY global_position
CREATE INDEX IF NOT EXISTS idx_events_type_position
  ON events (type, global_position);
```

**Performance note for very large stores (>500M events):** add `PARTITION BY RANGE (global_position)` (100M rows/partition) or `PARTITION BY RANGE (occurred_at)` for time-bounded queries. Each partition gets its own GIN index. Partition pruning skips irrelevant partitions on bounded queries.

---

## Query DSL — Design

### Internal representation

A `QueryDefinition` is a list of **clauses**. Each clause targets one event type and carries an optional filter tree. Multiple clauses are OR-ed together (enabling multi-type queries in one call).

```
QueryDefinition
  clauses: Clause[]

Clause
  type: string
  filter: FilterNode | null

FilterNode (recursive union)
  | { kind: 'attr', key: string, value: any }     -- leaf: single key/value match
  | { kind: 'and',  filters: FilterNode[] }        -- AND group
  | { kind: 'or',   filters: FilterNode[] }        -- OR group
```

The `QueryDefinition` is the value passed to `load()` and `append()` — no explicit `.build()` call required.

### DSL type chain

The key constraint: `.where`, `.or`, `.and` must be **properties** (not method calls) — they return a builder with a `key()` method.

```
query.eventsOfType('T')           → ClauseBuilder  (is a valid QueryDefinition)
  .where                          → KeySelector     (property, not a call)
    .key('k')                     → ValueSetter
      .equals('v')                → ClauseBuilder  (new immutable instance)
        .or                       → KeySelector     (property, not a call)
          .key('k2').equals('v2') → ClauseBuilder
        .and                      → KeySelector     (property, not a call)
          .key('k3').equals('v3') → ClauseBuilder
        .eventsOfType('T2')       → ClauseBuilder  (appends a second clause)
```

**All builder objects are immutable.** Every `equals()` call returns a new `ClauseBuilder` — the previous instance is never mutated.

**Filter merging rules:**
- `where` — sets the first filter on the current clause (no prior filter expected)
- `and` — merges into a flat AND node: `{ kind: 'and', filters: [...existing, newFilter] }`
- `or` — merges into a flat OR node: `{ kind: 'or', filters: [...existing, newFilter] }`
- Multiple `.or` calls accumulate into a single OR node with N children (not nested)

### Top-level `query` entry point

```
query.allEventsOfType(type)   → ClauseBuilder with no filter
query.eventsOfType(type)      → ClauseBuilder with no filter (chain .where to add filters)
```

Both return the same thing — `allEventsOfType` is a readable alias for the no-filter case.

---

## Query Compiler

Compiles a `QueryDefinition` into a parameterized PostgreSQL query.

**Mapping rules:**
- `{ kind: 'attr', key, value }` → `payload @> <jsonValue>::jsonb`
  (where `<jsonValue>` = `{"key": value}` serialized as JSON)
- `{ kind: 'and', filters }` → `(f1 AND f2 AND ...)`
- `{ kind: 'or',  filters }` → `(f1 OR f2 OR ...)`
- Each clause wraps as: `(type = <param> AND <filter>)` or `(type = <param>)` if no filter
- Multiple clauses join at the top level with `OR`

**Example — OR filter:**
```
query.eventsOfType('OrderCreated')
  .where.key('status').equals('pending')
  .or.key('status').equals('active')
```
Compiles to:
```sql
SELECT global_position, event_id, type, payload, metadata, occurred_at
FROM events
WHERE (type = $1 AND (payload @> $2::jsonb OR payload @> $3::jsonb))
ORDER BY global_position ASC
-- params: ['OrderCreated', '{"status":"pending"}', '{"status":"active"}']
```

**Example — AND filter:**
```
query.eventsOfType('OrderCreated')
  .where.key('customerId').equals('c1')
  .and.key('region').equals('EU')
```
Compiles to:
```sql
WHERE (type = $1 AND (payload @> $2::jsonb AND payload @> $3::jsonb))
```

**Example — multi-type (two clauses):**
```
query.eventsOfType('OrderCreated').where.key('orderId').equals('o1')
     .eventsOfType('OrderShipped').where.key('orderId').equals('o1')
```
Compiles to:
```sql
WHERE ((type = $1 AND payload @> $2::jsonb) OR (type = $3 AND payload @> $4::jsonb))
```

**Version check variant** (used for concurrency detection — no ORDER BY, aggregate only):
```sql
SELECT COALESCE(MAX(global_position), 0) AS max_pos
FROM events
WHERE <same compiled filter>
```

---

## Core Domain Types

```
NewEvent
  type: string
  payload: map/object
  metadata: map/object  (optional)

StoredEvent
  globalPosition: integer (64-bit)
  eventId: UUID string
  type: string
  payload: map/object
  metadata: map/object | null
  occurredAt: timestamp

LoadResult
  events: StoredEvent[]
  version: integer (64-bit)   -- MAX(global_position), or 0 if no events matched

AppendOptions
  query: QueryDefinition          -- used for concurrency check
  expectedVersion: integer (64-bit)
  concurrencyQuery: QueryDefinition  (optional — overrides query for conflict check only)

EventStore (interface)
  load(query)                  → LoadResult
  append(event | events, options?) → StoredEvent[]
  stream(query, options?)      → iterable of StoredEvent
  initializeSchema()           → void
  close()                      → void

StreamOptions
  batchSize: integer   (default 100)
  afterPosition: integer (64-bit, optional — start after this global_position)
```

---

## Concurrency Detection Algorithm

**Transaction flow inside `append()`:**

```
BEGIN  (connection dedicated to this transaction)

  IF AppendOptions provided:
    → run version-check query (compileVersionCheckQuery on concurrencyQuery ?? query)
    → actualVersion = COALESCE(MAX(global_position), 0)

    → IF actualVersion ≠ expectedVersion:
        ROLLBACK
        raise ConcurrencyError(expectedVersion, actualVersion)

  FOR EACH event:
    INSERT INTO events (type, payload, metadata)
    VALUES (...)
    RETURNING global_position, event_id, type, payload, metadata, occurred_at

COMMIT
→ return list of StoredEvents
```

**How the caller uses it:**
```
result = store.load(q)
-- process result.events, produce new events ...
store.append(newEvents, { query: q, expectedVersion: result.version })
```

- When no events match, `version = 0` — first write passes the check automatically
- `concurrencyQuery` is useful when the conflict-detection scope differs from the load scope (e.g., load a broad customer history but only detect conflicts on a specific order type)

---

## Streaming

Uses a PostgreSQL **named server-side cursor** with keyset pagination — never `OFFSET` (which degrades to O(N) at scale).

```sql
BEGIN
DECLARE <cursorName> NO SCROLL CURSOR FOR
  SELECT ... FROM events
  WHERE <compiled filters> AND global_position > <afterPosition>
  ORDER BY global_position ASC

FETCH <batchSize> FROM <cursorName>   -- repeat until 0 rows returned
CLOSE <cursorName>
COMMIT
```

- A dedicated DB connection is held open for the lifetime of the stream
- Early termination (caller stops iterating) closes the cursor and releases the connection
- `batchSize` (default 100) trades memory for round-trip count

---

## Public API Surface

```
query                  -- entry point for building queries
  .eventsOfType(type)
  .allEventsOfType(type)

PostgresEventStore(config)  -- concrete implementation
  .load(query)
  .append(events, options?)
  .stream(query, options?)
  .initializeSchema()
  .close()

ConcurrencyError       -- thrown when expectedVersion ≠ actual
EventStoreError        -- wraps DB-level errors

-- types --
QueryDefinition, NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore
```

---

## Implementation Sequence

1. **Internal query types** — QueryDefinition, Clause, FilterNode
2. **Query builder** — ClauseBuilder, KeySelector, ValueSetter; immutability, property getters
3. **`query` entry point** — top-level `eventsOfType` / `allEventsOfType`
4. **Unit tests: query builder** — all DSL chains, immutability, multi-type
5. **Query compiler** — QueryDefinition → parameterized SQL; both load and version-check variants
6. **Unit tests: query compiler** — SQL string correctness for all filter node types
7. **Core types & errors** — domain types, ConcurrencyError, EventStoreError
8. **DB schema** — DDL + index definitions
9. **Row mapper** — DB row → StoredEvent
10. **PostgresEventStore** — load, append (with concurrency transaction), stream (cursor)
11. **Integration tests** — append, load, concurrency detection, filter correctness, streaming
12. **Public API barrel** — expose only the intended public surface

---

## Verification

- **Unit tests** — query builder and compiler pass with no database required
- **Integration tests** — all store operations against a real PostgreSQL instance:
  - append single and multiple events
  - load with all filter combinations
  - `ConcurrencyError` thrown on stale version
  - successful append when version matches (including first write at version 0)
  - stream returns events in `global_position` order with correct batching
- **Build** — library compiles cleanly with no type errors
- **Smoke test** — manually create a store, initialize schema, run a full load → process → append cycle
