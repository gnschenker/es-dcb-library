# Tag Model Migration Plan

This document outlines the step-by-step migration from the current payload-based query model to the DCB spec's tag-based model (https://dcb.events).

---

## Goals

1. **Achieve DCB spec compliance**: implement the tag-based event model, query API, and append condition defined by the DCB specification
2. **Fix known consistency gaps**:
   - Overlapping queries can both append (advisory lock is keyed on query text, not data coverage)
   - Writers that lose the lock race get spurious `ConcurrencyError` instead of waiting
   - The README's `concurrencyQuery` example fails due to version/scope mismatch
   - Projections can skip events due to BIGSERIAL commit-order gaps
3. **Maintain backward compatibility during migration**: each step keeps existing functionality working until removal is safe
4. **Improve terminology**: correct "Dynamic Context Boundaries" → "Dynamic Consistency Boundary" throughout

---

## Current State

### Schema
- Single `events` table: `global_position BIGSERIAL, event_id UUID, type VARCHAR(255), payload JSONB, metadata JSONB, occurred_at TIMESTAMPTZ`
- Indexes: B-tree `(type, global_position)`, GIN `(payload jsonb_path_ops)`, BRIN `(occurred_at)`

### Query Model
- Query DSL: `query.eventsOfType(T).where.key(k).equals(v).and/.or...`
- Clauses are OR'ed: `(type = $1 AND payload @> $2::jsonb) OR (type = $3 AND payload @> $4::jsonb)`
- No tags; filters use JSONB containment on payload

### Append Condition
- `{query, expectedVersion, concurrencyQuery?}`
- Advisory lock key: `hashtext(compileCanonicalKey(concurrencyQuery ?? query))`
- Version check: `MAX(global_position)` of matches must equal `expectedVersion`

### Known Issues
1. **Overlapping queries hole**: two queries that overlap but differ textually get different locks → both can append under READ COMMITTED
2. **Lock contention UX**: `pg_try_advisory_xact_lock` fails fast → spurious `ConcurrencyError` for writers that merely lost the race
3. **concurrencyQuery mismatch**: `version` from broad load vs `MAX` of narrow check → spurious failures
4. **BIGSERIAL gaps**: positions assigned before commit → out-of-order commits → projections/stream can skip events permanently

---

## Target State (DCB Spec)

### Event Model
- Events carry `type: string`, `data: opaque`, and `tags: string[]`
- Tags are indexed for fast filtering

### Query Model
- Query = list of items, each with `types: string[]` and `tags: string[]`
- An item matches when:
  - Event type is one of `types` (empty = any type)
  - Event has ALL of `tags`
- Items are OR'ed

### Append Condition
```typescript
{
  failIfEventsMatch: Query,
  after?: bigint  // highest position client was aware of
}
```

### Read API
```typescript
read(query: Query, options?: {from?: bigint, limit?: number}): SequencedEvent[]
```

---

## Migration Steps

### Step 1: Add Tags to Schema and Append (Current PR)

**Goal**: Introduce tags as an additive feature. Existing payload-based queries continue to work.

**Deliverables**:
1. Add `tags TEXT[]` column to `events` table
2. Add GIN index on `tags` using `gin(tags array_ops)` for `@>` (contains) queries
3. Schema migration safe for existing databases: `ALTER TABLE events ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`
4. Extend `NewEvent` interface: `tags?: string[]` (optional, defaults to `[]`)
5. Extend `StoredEvent` interface: `tags: string[]`
6. Add optional tag extractor API: `append(events, {tagExtractor?: (event: NewEvent) => string[]})`
   - If provided, extractor runs per event and merges with `event.tags ?? []`
   - Allows centralized tag derivation (e.g. `teacherId:t1` from payload) without changing call sites
7. Return `tags` on `load()` and `stream()`
8. Keep existing query DSL and append behavior unchanged
9. Update README with tag usage examples
10. Add unit and integration tests for tags

**Schema Change**:
```sql
ALTER TABLE events ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_events_tags_gin ON events USING GIN (tags array_ops);
```

**API Changes** (additive only):
```typescript
// NewEvent: tags optional
interface NewEvent {
  type: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];  // NEW
}

// StoredEvent: tags always present
interface StoredEvent {
  globalPosition: bigint;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  tags: string[];  // NEW
}

// Append: optional tag extractor
interface AppendOptions {
  query: QueryDefinition;
  expectedVersion: bigint;
  concurrencyQuery?: QueryDefinition;
  tagExtractor?: (event: NewEvent) => string[];  // NEW
}
```

**Migration Safety**:
- Existing events: `tags` column defaults to `'{}'` (empty array)
- Existing `append()` calls: events without `tags` get `[]`
- Existing `load()` / `stream()` return values: readers see `tags: []` for old events
- No breaking changes to public API

**Test Coverage**:
- Unit: append with tags, load with tags, row mapper handles tags
- Integration: append + read round-trip, tag extractor, backfill old events with tags

---

### Step 2: Tag-Based Query API and Compiler

**Goal**: Implement the DCB spec's query model alongside the existing payload DSL.

**Deliverables**:
1. New query builder: `query.items([{types: [...], tags: [...]}, ...])`
2. `QueryItem` type: `{types?: string[], tags?: string[]}`
3. Compiler for tag queries: `(type = ANY($1) OR $1 = '{}') AND tags @> $2::text[]`
4. Support mixing old and new query styles (internal representation distinguishes them)
5. Add integration tests: tag queries vs payload queries return correct events

**API**:
```typescript
// New item-based query builder
query.items([
  { types: ['OrderCreated'], tags: ['customer:c1'] },
  { types: ['OrderShipped'], tags: ['customer:c1'] },
]);

// Empty types = any type
query.items([{ tags: ['customer:c1'] }]);

// Empty tags = match on type only
query.items([{ types: ['OrderCreated', 'OrderShipped'] }]);
```

**Coexistence**:
- `QueryDefinition` gains a discriminant: `{kind: 'payload', clauses: Clause[]} | {kind: 'tag', items: QueryItem[]}`
- Compiler dispatches on `kind`
- Both APIs route through the same `load()` / `stream()` / `append()`

**Constraints**:
- Cannot mix payload and tag queries in a single `QueryDefinition` (throw if attempted)
- Lock key generation works for both (fallback: serialize to JSON, hash)

---

### Step 3: Spec-Compliant Append Condition with Tag Locking

**Goal**: Replace `{query, expectedVersion, concurrencyQuery?}` with `{failIfEventsMatch, after?}`. Fix overlapping-query hole and lost-race UX.

**Deliverables**:
1. New `AppendCondition` interface matching the spec:
   ```typescript
   interface AppendCondition {
     failIfEventsMatch: QueryDefinition;  // must be tag-based
     after?: bigint;
   }
   ```
2. Deprecate old `AppendOptions` but keep it working (map to new model internally)
3. Tag-based locking: acquire advisory locks for every `(type, tag)` pair in the query
   - Deterministic sort order: `[(type1, tag1), (type1, tag2), (type2, tag1), ...]`
   - Hash each pair: `pg_try_advisory_xact_lock(hashtext(type || ':' || tag))`
   - Acquire all locks or fail atomically (rollback if any lock fails)
4. For lost-race scenario: retry lock acquisition with exponential backoff (up to N attempts) before throwing `ConcurrencyError`
   - This fixes the "writer that lost the race gets spurious error" problem
5. Condition check: `SELECT EXISTS (SELECT 1 FROM events WHERE <tag-query> AND global_position > $after LIMIT 1)`
   - If `after` is omitted, fail if any match exists
6. Update README and examples to use new condition API
7. Add integration test: two overlapping tag queries now correctly serialize

**Backward Compatibility**:
- Old `AppendOptions` internally maps to `AppendCondition`:
  - `failIfEventsMatch = concurrencyQuery ?? query`
  - `after = expectedVersion`
  - Only works if the query is tag-based; payload queries log a deprecation warning but continue to use the old lock-by-query-text mechanism

**Lock Acquisition Strategy**:
```typescript
// Pseudo-code for tag-based locking
const pairs = extractTypeTagPairs(failIfEventsMatch);
pairs.sort((a, b) => a.type.localeCompare(b.type) || a.tag.localeCompare(b.tag));

for (const {type, tag} of pairs) {
  const key = `${type}:${tag}`;
  const acquired = await client.query(
    'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
    [key]
  );
  if (!acquired) {
    // Retry with backoff or rollback and throw ConcurrencyError
  }
}
```

**Edge Cases**:
- Query with no tags: lock on `(type, '')` or a global sentinel
- Query with `types: []` (any type) and specific tags: lock on `('*', tag)` sentinel
- Deadlock risk: deterministic sort order prevents lock-order deadlocks

---

### Step 4: Migrate Projections and University-App; Backfill Tags

**Goal**: Convert all existing code to use tags. Backfill tags for old events.

**Deliverables**:
1. Update projections addon to use tag queries (update `defineProjection` examples)
2. Convert university-app command handlers to tag-based queries:
   - `query.items([{types: ['TeacherHired'], tags: ['teacher:t1']}])`
3. Add migration script: `npm run migrate:backfill-tags`
   - Reads all events, derives tags from payload using domain logic, updates rows
   - Runs as a one-time setup script, idempotent
4. Update all integration tests to use tag queries
5. Update README examples to use tags

**Tag Derivation Rules** (university-app example):
- `TeacherHired` → `['teacher:<teacherId>']`
- `CourseCreated` → `['course:<courseId>']`
- `StudentEnrolled` → `['course:<courseId>', 'student:<studentId>', 'enrollment:<enrollmentId>']`

**Backfill Script**:
```typescript
// tools/backfill-tags.ts
const events = await pool.query('SELECT global_position, type, payload FROM events WHERE tags = \'{}\'');
for (const row of events.rows) {
  const tags = deriveTagsFromPayload(row.type, row.payload);
  await pool.query('UPDATE events SET tags = $1 WHERE global_position = $2', [tags, row.global_position]);
}
```

---

### Step 5: Remove Payload Query DSL

**Goal**: Delete the old payload-based query API and compiler. Only tag queries remain.

**Deliverables**:
1. Remove `ClauseBuilder`, `KeySelector`, `ValueSetter` from `query/builder.ts`
2. Remove `.where.key().equals()` API
3. Remove `Clause`, `FilterNode` types
4. Remove payload filter compilation from `compiler.ts`
5. Simplify `QueryDefinition` to only contain items:
   ```typescript
   interface QueryDefinition {
     readonly items: readonly QueryItem[];
   }
   ```
6. Remove GIN index on `payload` (no longer queried)
7. Update schema: `ALTER TABLE events DROP COLUMN payload` (OPTIONAL — see note below)
8. Update README: remove all payload query examples

**Decision Point**: Keep or drop the `payload` column?
- **Keep**: allows freeform event data without enforcing a schema; upcasting/migrations easier
- **Drop**: saves space; DCB spec only defines `data: opaque`, but doesn't require removal
- **Recommendation**: KEEP `payload` as `data`, just stop indexing it

**Breaking Changes**:
- Any external code using `.where.key()` will break → bump to v1.0.0
- Migration guide: show old `.where.key('orderId').equals('o1')` vs new `.items([{types: ['OrderCreated'], tags: ['order:o1']}])`

---

### Step 6: Fix Projection Gaps (BIGSERIAL Commit-Order Issue)

**Goal**: Prevent projections from skipping events due to out-of-order commits.

**Problem**:
- `BIGSERIAL` assigns `global_position` before commit
- Two concurrent transactions: T1 gets position 100, T2 gets position 101
- If T2 commits before T1, a projection reading up to position 101 misses T1's event forever

**Possible Solutions**:

#### Option A: xmin-Based Safe Horizon
1. Projections query: `SELECT global_position, xmin, ... FROM events WHERE ... AND global_position > $checkpoint ORDER BY global_position ASC LIMIT $batch`
2. After processing each batch, compute safe horizon: `min(xmin of in-flight transactions)`
3. Only checkpoint up to `max(global_position WHERE xmin < safe_horizon)`
4. Requires querying `pg_stat_activity` or maintaining a transaction registry

**Pros**: No schema change, no serialization  
**Cons**: Complex; requires xmin visibility; doesn't work with logical replication

#### Option B: Serialized Append
1. Acquire a single global advisory lock before every `append()`:
   ```sql
   SELECT pg_advisory_xact_lock(hashtext('es_dcb_append_lock'));
   ```
2. Only one transaction can assign positions at a time → no gaps

**Pros**: Simple; guarantees order  
**Cons**: Serializes all writes; loses concurrency for unrelated streams (partially mitigated by separate tag-level locks)

#### Option C: Commit Timestamp + Polling Window
1. Add `commit_ts TIMESTAMPTZ DEFAULT clock_timestamp()` (set at commit time, not statement time)
2. Projections checkpoint: only read events where `commit_ts < now() - $safetyWindow` (e.g. 5 seconds)
3. Wait for late commits to land before advancing

**Pros**: No xmin complexity; works with replication  
**Cons**: Adds latency; not foolproof if clock skew exists

#### Option D: Explicit Sequence Commitment Table
1. Add `committed_positions` table: `(global_position BIGINT PRIMARY KEY, committed_at TIMESTAMPTZ)`
2. After commit, insert position into `committed_positions`
3. Projections: only process events whose positions exist in `committed_positions`
4. Periodic cleanup: delete committed_positions older than N days

**Pros**: Explicit, no xmin, works everywhere  
**Cons**: Extra table; extra write per append

**Recommendation**: Start with **Option B (serialized append)** for simplicity and correctness, then consider Option A (xmin horizon) if write throughput becomes a bottleneck. The tag-based locking in Step 3 already provides fine-grained concurrency within the global append lock.

**Deliverables**:
1. Add global append lock acquisition at the start of `append()` (after BEGIN, before tag locks)
2. Update projection loop to trust position ordering (no special handling needed with serialized append)
3. Add integration test: concurrent appends + projection never skips events
4. Document the trade-off in architecture docs

---

## Implementation Order Summary

| Step | Description | Breaking? | Status |
|------|-------------|-----------|--------|
| 1 | Add tags to schema & append (additive) | No | Planned |
| 2 | Tag-based query API alongside old API | No | Planned |
| 3 | New append condition with tag locking | No (old API deprecated) | Planned |
| 4 | Migrate projections, university-app, backfill | No | Planned |
| 5 | Remove payload query DSL | Yes → v1.0.0 | Planned |
| 6 | Fix projection gaps (serialized append) | No (perf impact) | Planned |

---

## Rollback Strategy

- **Step 1**: Safe rollback — drop `tags` column and index
- **Step 2**: Safe rollback — new API is unused
- **Step 3**: Deprecation only — old API still works
- **Step 4**: Backfill is idempotent; re-run if needed
- **Step 5**: Breaking change — requires major version bump, no rollback without data migration
- **Step 6**: Revert global lock — may reintroduce gaps but unblocks writes

---

## Testing Strategy

Each step includes:
1. **Unit tests**: new APIs, compilers, edge cases
2. **Integration tests**: round-trip via PostgreSQL, concurrency scenarios
3. **Backward compatibility tests**: existing tests continue to pass until Step 5
4. **Migration tests**: backfill script correctness, old-to-new query equivalence

University-app serves as a real-world test harness: if it passes integration tests after Step 4, the migration is solid.

---

## Open Questions for Gabriel

1. **Payload column**: keep or drop after Step 5? (Recommendation: keep as `data`)
2. **Projection gap fix**: serialize appends (Option B) or xmin horizon (Option A)? (Recommendation: B for now)
3. **Lock retry strategy**: how many retries? What backoff? (Recommendation: 3 retries, exponential 50ms → 200ms → 800ms)
4. **Tag extractor API**: per-event-type registry or per-append callback? (Recommendation: per-append for flexibility, Step 1 implements callback)
5. **Version number**: does v1.0.0 ship after Step 5, or earlier?
6. **npm publish**: when should the first public release happen? After which step?

---

## Terminology Fixes

Throughout the migration, correct all instances of "Dynamic **Context** Boundaries" to "Dynamic **Consistency** Boundary" in:
- README.md
- All .docs/ files
- Code comments
- Test descriptions
- University-app docs

This will be done incrementally in each PR that touches the relevant files.
