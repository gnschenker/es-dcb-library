# DCB Tag Model Design

This document describes the DCB (Dynamic Consistency Boundary) tag model implementation in `es-dcb-library`, aligned with the specification at https://dcb.events.

---

## Core Concepts

### Events with Tags

Events carry a type and a set of string tags:

```typescript
interface StoredEvent {
  globalPosition: bigint;
  eventId: string;
  type: string;
  data: Record<string, unknown>;  // opaque payload
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  tags: string[];                  // indexed for fast queries
}
```

Tags are arbitrary strings with no enforced structure. Common convention: `entity:id` (e.g., `order:o1`, `customer:c1`).

### Query Model

A query is a list of items, combined with OR:

```typescript
interface Query {
  items: QueryItem[];
}

interface QueryItem {
  types?: string[];   // event types to match (empty = any type)
  tags?: string[];    // tags event must have (AND constraint)
}
```

An event matches an item when:
- The event's type is in `types` (or `types` is empty/undefined, matching any type)
- The event has **ALL** of the `tags`

Items are OR'ed: an event matches the query if it matches **ANY** item.

#### Examples

```typescript
// All OrderCreated events
queryItem({ types: ['OrderCreated'] })

// All events tagged with order:o1 (any type)
queryItem({ tags: ['order:o1'] })

// OrderCreated AND OrderShipped for order:o1
query([
  { types: ['OrderCreated'], tags: ['order:o1'] },
  { types: ['OrderShipped'], tags: ['order:o1'] },
])

// Events for customer c1 (any type, but must have both tags)
queryItem({ tags: ['customer:c1', 'verified'] })

// All events (no constraints)
queryAll()  // equivalent to query([{}])
```

### Append Condition

The append condition enforces optimistic concurrency:

```typescript
interface AppendCondition {
  failIfEventsMatch: Query;
  after?: bigint;
}
```

Semantics: fail the append if any event matching `failIfEventsMatch` exists with `global_position > after`.

**Usage**:
1. Load events with a query: `const { events, version } = await store.load(query)`
2. Build decision model from `events`
3. Append new events: `store.append(newEvents, { failIfEventsMatch: query, after: version })`

If another writer appended matching events between steps 1 and 3, the append fails with `ConcurrencyError`.

---

## Tag-Based Locking

### Problem: Overlapping Queries

With the old query-hash locking, two queries that overlap but differ textually get different locks:

```typescript
// Query A: orderId filter
query.eventsOfType('OrderCreated').where.key('orderId').equals('o1')

// Query B: customerId filter (but same order o1)
query.eventsOfType('OrderCreated').where.key('customerId').equals('c1')
```

Both can acquire their locks and append concurrently under READ COMMITTED, violating the DCB guarantee.

### Solution: Per-Tag Locks

Extract all `(type, tag)` pairs from the query and acquire advisory locks for each:

```typescript
// Query: { types: ['OrderCreated'], tags: ['order:o1', 'customer:c1'] }
// Pairs extracted:
//   - (OrderCreated, order:o1)
//   - (OrderCreated, customer:c1)
// Lock keys (sorted):
//   - hashtext('OrderCreated:order:o1')
//   - hashtext('OrderCreated:customer:c1')
```

**Key properties**:
- Overlapping queries share locks → serialize correctly
- Deterministic sort order → prevents deadlocks
- Transaction-scoped (`pg_advisory_xact_lock`) → auto-released on COMMIT/ROLLBACK

### Lock Retry

Writers that lose the lock race retry with exponential backoff (50ms → 200ms → 800ms) instead of failing immediately. This fixes the "spurious ConcurrencyError" problem.

### Edge Cases

- **Query with no tags**: Lock on `(type, '')` (empty tag)
- **Query with no types (any type)**: Lock on `('*', tag)` (wildcard type)
- **Multiple types × multiple tags**: Cartesian product of locks

---

## Tag Extractors

Tag extractors derive tags from event data automatically:

```typescript
const store = new PostgresEventStore({
  pool,
  tagExtractors: {
    OrderCreated: (event) => [
      `order:${event.data.orderId}`,
      `customer:${event.data.customerId}`,
    ],
    OrderShipped: (event) => [`order:${event.data.orderId}`],
  },
});
```

When appending:
- Extractor runs if registered for the event type
- Output is merged with `event.tags` (if present)
- Duplicates are removed

**Design rationale**: Per-type registration in store config (not per-append callback) centralizes tagging logic and ensures consistency across all writers.

---

## Schema Design

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

**Indexes**:
- `idx_events_tags_gin`: Fast containment queries (`tags @> ARRAY['tag1', 'tag2']`)
- `idx_events_type_position`: Type filter + ordered range scans
- `idx_events_occurred_at_brin`: Time-bounded queries (tiny, near-zero write cost)

**No index on `data`**: Payload is opaque and not queried. Filtering is tag-based only.

---

## SQL Compilation

### Query Item → SQL

```typescript
// Item: { types: ['EventA', 'EventB'], tags: ['tag1', 'tag2'] }
// SQL:
WHERE (type = ANY(ARRAY['EventA', 'EventB']) AND tags @> ARRAY['tag1', 'tag2'])
```

- Empty `types`: no type constraint (matches any type)
- Empty `tags`: no tag constraint (matches events with no tags or any tags)
- Both empty: `WHERE TRUE` (matches all events)

### Multiple Items → OR

```typescript
// Query: [
//   { types: ['EventA'], tags: ['tag1'] },
//   { types: ['EventB'], tags: ['tag2'] }
// ]
// SQL:
WHERE (
  (type = ANY(ARRAY['EventA']) AND tags @> ARRAY['tag1'])
  OR
  (type = ANY(ARRAY['EventB']) AND tags @> ARRAY['tag2'])
)
```

### Append Condition → EXISTS

```typescript
// Condition: { failIfEventsMatch: query, after: 42n }
// SQL:
SELECT EXISTS (
  SELECT 1
  FROM events
  WHERE <compiled-query> AND global_position > 42
  LIMIT 1
) AS exists
```

If `exists = true`, the append fails with `ConcurrencyError`.

---

## Comparison to DCB Spec

| DCB Spec | This Implementation |
|----------|---------------------|
| `Event.tags: string[]` | ✅ `StoredEvent.tags: string[]` |
| `Event.data: opaque` | ✅ `StoredEvent.data: JSONB` (not queried) |
| `Query = QueryItem[]` | ✅ `Query.items: QueryItem[]` |
| `QueryItem.types[]` | ✅ `QueryItem.types?: string[]` |
| `QueryItem.tags[]` | ✅ `QueryItem.tags?: string[]` |
| `AppendCondition.failIfEventsMatch` | ✅ `AppendCondition.failIfEventsMatch: Query` |
| `AppendCondition.after?: position` | ✅ `AppendCondition.after?: bigint` |
| `read(query, {from, limit})` | ✅ `load(query)` + `stream(query, {afterPosition, batchSize})` |

**Full compliance** with the DCB spec's query and append condition model.

---

## Known Limitations (Deferred)

### Projection Gap-Safety

**Problem**: `BIGSERIAL` assigns `global_position` before commit. If transaction T1 gets position 100 and T2 gets 101, but T2 commits first, a projection reading up to position 101 misses T1's event permanently.

**Solution** (deferred to follow-up PR): Only read events up to a safe committed position. Options:
- **Global append lock**: Serialize all appends (simplest, loses concurrency)
- **xmin-based horizon**: Track in-flight transactions and only read committed events
- **Commit timestamp + polling window**: Add `commit_ts` and wait before advancing

### University-App Migration

The example app (`university-app/`) still uses the old payload-based API. Deferred to a separate PR that:
- Updates all command handlers to use tags
- Registers tag extractors per event type
- Migrates existing events (if any) to have tags

### Comprehensive Documentation

README needs a full rewrite to:
- Remove all payload-based query examples
- Document tag-based API comprehensively
- Explain tag extractor usage
- Update concurrency examples

---

## Design Decisions

### Tag Format: Arbitrary Strings

No enforced structure (e.g., `key:value`). Rationale:
- Aligns with DCB spec (tags are opaque)
- Allows application-specific conventions
- Library doesn't parse or validate semantics

### Tag Extractor: Per-Type Registration

Chosen over per-append callback. Rationale:
- Centralizes tagging logic (consistency across writers)
- Avoids accidental tag divergence
- Simpler API (one configuration point)

### Lock Retry: Exponential Backoff

Retry 3 times with delays 50ms → 200ms → 800ms. Rationale:
- Fixes spurious `ConcurrencyError` for concurrent writers
- Exponential backoff avoids thundering herd
- 3 retries = balance between responsiveness and fairness

### Schema: Tags Required (No Default)

`tags TEXT[] NOT NULL` with no default. Rationale:
- Clean schema (no migration logic)
- Forces explicit tag design decisions
- Aligns with "no backward compatibility" directive

---

## Future Work

1. **Projection gap-safety** (blocking issue for production use)
2. **University-app migration** (demonstrates real-world usage)
3. **Projection tests** (restore coverage for addon)
4. **README rewrite** (user-facing documentation)
5. **Performance benchmarks** (tag-based queries vs old payload queries)
6. **Subquery support** (if needed for complex scenarios)

---

## References

- DCB Specification: https://dcb.events
- Original design: `.docs/plan.md` (archived)
- Architecture review: `.docs/architecture-review.md`
