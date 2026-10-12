# Committed-Only Stream for Projection Safety

## The problem: out-of-order BIGSERIAL commits

PostgreSQL assigns `global_position` from a sequence at insert time, **before** the transaction commits. Writers can commit in a different order than their positions:

1. Transaction T reserves position `p` (or inserts with `p` but stays open).
2. Transaction S reserves `q > p`, inserts, and commits.
3. A follower reads up to `q` and advances its checkpoint.
4. T commits later with position `p`.

**Result:** position `p` is permanently skipped.

This is worse when `nextval` is consumed before the heap insert: T can hold `p` while S already committed `q`.

## Why row `xmin` alone is not sound

Using `MAX(global_position)` among rows whose system `xmin` is below the snapshot horizon is **not** sufficient: a committed row at `q` can appear safe while an older open transaction still owns an uncommitted row at `p < q`.

## Why gap-based “safe position” is not sound (liveness)

Sequences are **non-transactional**. Any rolled-back insert, failed append, or crash after `nextval` burns that position forever. A follower that waits until every integer up to `sequence.last_value` is committed stalls permanently when a hole never fills.

## Solution: committed-only stream + `(tx_id, global_position)` cursor

### Schema

```sql
tx_id xid8 NOT NULL DEFAULT pg_current_xact_id()
```

Index: `(tx_id, global_position)` for ordered scans.

### Visibility rule

Only read rows with:

```sql
tx_id < pg_snapshot_xmin(pg_current_snapshot())
```

`pg_snapshot_xmin` is the oldest XID still active. Any row whose inserting transaction is still in progress has `tx_id >= xmin` and is excluded — **even if another backend already committed a higher `global_position`**. Sequence holes from rollbacks do not matter; there is no row to read for burned positions.

### Ordering and checkpoint

- `ORDER BY tx_id ASC, global_position ASC`
- Keyset pagination: `(tx_id, global_position) > ($after_tx, $after_pos)`
- Checkpoint stores both `last_tx_id` and `last_position` (the last processed pair)

### API

- `StreamOptions.committedOnly: true` — projection loops and safe followers
- `StreamOptions.afterCursor` — resume from checkpoint pair (`STREAM_CURSOR_ORIGIN` = before any event)

Legacy `afterPosition` streaming (no xmin filter) remains for callers that accept visibility of uncommitted-adjacent committed rows.

## Implementation

- `compileCommittedStreamQuery()` in `src/query/compiler.ts`
- `PostgresEventStore.stream()` with `committedOnly`
- Projection loops in `src/projections/loop.ts`; checkpoints in `projection_checkpoints`

## Testing

`tests/integration/committed-stream.test.ts`:

1. Classic T1 open / T2 commits first.
2. Nextval-before-insert interleaving while T holds `p`.
3. Cursor continuation after partial checkpoint.
4. **Rollback liveness:** `BEGIN` → `INSERT` → `ROLLBACK` (sequence hole) → more appends → committed stream and projections still catch up.

## References

- PostgreSQL MVCC: https://www.postgresql.org/docs/current/mvcc.html
- `pg_current_xact_id()`, `pg_current_snapshot()`, `pg_snapshot_xmin()`
