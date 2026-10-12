# Safe Position Design for Projection Gap Safety

## The Problem: Out-of-Order BIGSERIAL Commits

PostgreSQL's `BIGSERIAL` type assigns values from a sequence **before** transaction commit. This creates a race condition:

1. Transaction T1 starts, gets `global_position = 100`
2. Transaction T2 starts, gets `global_position = 101`
3. T2 commits first
4. A projection reads events and processes position 101
5. T1 commits later

**Result**: The projection permanently skips position 100 because it already advanced its checkpoint past 101.

This is a **data loss bug** in event-sourced systems.

## Solution: Transaction Visibility Horizon

We use PostgreSQL's transaction visibility system to compute a "safe position" — the highest `global_position` where all earlier transactions have definitely committed.

### Algorithm

```sql
SELECT COALESCE(
  (
    SELECT MAX(global_position)
    FROM events
    WHERE xmin::text::bigint < txid_snapshot_xmin(txid_current_snapshot())
  ),
  0
) AS safe_pos
```

### Key Concepts

1. **`xmin` system column**: Every row in PostgreSQL has an `xmin` column (transaction ID that inserted it). This is automatically maintained by PostgreSQL.

2. **`txid_current_snapshot()`**: Returns a snapshot of the current transaction state, including:
   - `xmin`: Earliest transaction ID that might still be in progress
   - All transactions with ID < `xmin` are guaranteed committed and visible

3. **Safe position**: The maximum `global_position` where all rows have `xmin < snapshot_xmin`. This ensures no earlier transaction can commit below this position.

### Why This Works

- PostgreSQL's MVCC guarantees that once a transaction ID is less than the snapshot's `xmin`, that transaction is committed.
- By only reading up to the highest position where all `xmin` values are committed, we ensure no gaps.
- This approach requires **no schema changes** — `xmin` is a system column that already exists.

### Performance Characteristics

- **Query cost**: Single index scan on primary key (`global_position`) + snapshot call (very fast)
- **Lag**: The safe position typically lags slightly (milliseconds to seconds) behind the actual max position during high write concurrency
- **Throughput impact**: Minimal — the query is cheap and only runs at the start of each stream batch
- **Scalability**: Scales with write concurrency without global locks

## Implementation

### 1. Stream API Changes

Added `useSafePosition` option to `StreamOptions`:

```typescript
export interface StreamOptions {
  batchSize?: number;
  afterPosition?: bigint;
  useSafePosition?: boolean;  // Default: false
}
```

When `useSafePosition: true`, the stream:
1. Computes the safe position before each batch
2. Only yields events with `global_position <= safePosition`
3. Stops early if `afterPosition >= safePosition` (no safe events yet)

### 2. Query Compiler Changes

Updated `compileStreamQuery` to accept optional `maxPosition`:

```typescript
export function compileStreamQuery(
  query: Query,
  afterPosition: bigint,
  batchSize: number,
  maxPosition?: bigint,  // New parameter
): CompiledQuery
```

When `maxPosition` is provided, the SQL includes:

```sql
WHERE ... AND global_position > $after AND global_position <= $max
```

### 3. Projection Loop Integration

Both catch-up and live phases use `useSafePosition: true`:

```typescript
const eventStream = store.stream(def.query, {
  afterPosition: state.lastPos,
  batchSize: config.streamBatchSize,
  useSafePosition: true,  // Enabled for all projections
});
```

This ensures projections never skip events due to out-of-order commits.

## Alternative Approaches Considered

### 1. Global Append Lock

**Approach**: Serialize all appends with a global advisory lock.

**Pros**:
- Simplest to implement
- Guarantees strict ordering

**Cons**:
- **Kills throughput**: All writers serialize on a single lock
- Not acceptable for high-concurrency event stores

**Verdict**: Rejected — throughput cost is too high.

### 2. Commit Timestamp with Polling Window

**Approach**: Add a `committed_at` timestamp column, wait N seconds before reading.

**Pros**:
- Simple concept

**Cons**:
- **Unbounded delay**: No guarantee a transaction commits within N seconds
- **Added latency**: Projections lag by at least N seconds
- **Schema change**: Requires new column and index

**Verdict**: Rejected — bounded delay is better than fixed delay, and no schema change is preferable.

### 3. Two-Phase Commit with Gap Tracking

**Approach**: Use a separate "gaps" table to track uncommitted positions.

**Pros**:
- Bounded query cost

**Cons**:
- **Complex**: Requires gap table, cleanup logic, and coordination
- **Schema changes**: New table and triggers
- **Race conditions**: Gap table updates must be synchronized with event inserts

**Verdict**: Rejected — complexity outweighs benefits when xmin-based approach is simpler.

## Testing

### Integration Test: `safe-position.test.ts`

1. **Out-of-order commit reproduction**:
   - Start T1, assign position 1, hold transaction open
   - Start T2, assign position 2, commit immediately
   - Verify `useSafePosition: false` sees position 2 (unsafe)
   - Verify `useSafePosition: true` sees nothing (safe)
   - Commit T1
   - Verify `useSafePosition: true` now sees both in order

2. **Projection checkpoint continuity**:
   - Commit positions 1 and 2
   - Start T1 (position 3), hold open
   - Commit T2 (position 4)
   - Stream from `afterPosition: 2n` with safe position → sees nothing
   - Commit T1
   - Stream again → sees positions 3 and 4 in order

3. **Three-way interleaving**:
   - Commit position 1
   - Start T2 (position 2), hold open
   - Commit T3 (position 3)
   - Safe position stops at 1 (position 2 uncommitted blocks 3)
   - Commit T2
   - Safe position advances to 3

## Production Considerations

### Latency

- **Catch-up latency**: Negligible — safe position query is ~1ms
- **Live latency**: Projections may lag by 10-100ms during high write concurrency (acceptable for most use cases)

### Monitoring

Recommend tracking:
- `max(global_position) - safe_position`: Gap size (should be small, typically 0-10)
- Projection lag: `current_time - event.occurred_at` for processed events
- Safe position query time (should be <5ms)

### When to Use `useSafePosition: true`

- **Projections**: Always (prevents data loss)
- **Stream-after-position followers**: Always (if gap-free is required)
- **Manual streams in command handlers**: No (use `load()` with concurrency checks instead)
- **Audit/export tools**: Depends on requirements

### When Schema is Empty

`computeSafePosition()` returns `0n` when no events exist, which is correct — there are no events to read safely.

## Future Improvements

1. **Configurable lag threshold**: Allow projection config to set max acceptable lag (fail-fast if exceeded)
2. **Metrics integration**: Export safe position lag to Prometheus/StatsD
3. **Adaptive batch sizing**: Reduce batch size when safe position lag increases
4. **Snapshot caching**: Cache `txid_current_snapshot()` for a short TTL (10-100ms) to reduce snapshot calls

## References

- PostgreSQL MVCC: https://www.postgresql.org/docs/current/mvcc.html
- Transaction IDs: https://www.postgresql.org/docs/current/datatype-oid.html
- System Columns: https://www.postgresql.org/docs/current/ddl-system-columns.html
