# Safe Position Design for Projection Gap Safety

## The Problem: Out-of-Order BIGSERIAL Commits

PostgreSQL's `BIGSERIAL` assigns `global_position` from a sequence at insert time, **before** the transaction commits. Writers can therefore commit in a different order than their positions:

1. Transaction T reserves position `p` (or inserts with `p` but stays open).
2. Transaction S reserves `q > p`, inserts, and commits.
3. A follower reads up to `q` and advances its checkpoint.
4. T commits later with position `p`.

**Result:** position `p` is permanently skipped.

This is worse when `nextval` is consumed before the heap insert: T can hold `p` while S already committed `q`, so a rule based only on "which rows are visible" can treat `q` as safe while `p` is still in flight.

## Why row `xmin` alone is not sound

An earlier approach used `MAX(global_position)` among rows whose system `xmin` is below the snapshot horizon. That is **not** sufficient:

- `global_position` comes from the sequence at insert planning time; `xmin` is assigned when the row version is written.
- A committed row at `q` can have `xmin < horizon` while an older open transaction still owns an uncommitted row at `p < q`.
- The follower then advances to `q` and never processes `p`.

This also implied scanning the table and casting `xmin` on every row each batch — poor performance at scale.

## Solution: explicit `tx_id` + position gap rule

### Schema

```sql
tx_id xid8 NOT NULL DEFAULT pg_current_xact_id()
```

`tx_id` is the inserting transaction's XID, captured in the same statement as the row.

Index: `(tx_id, global_position)` for horizon lookups.

### Horizon

```sql
pg_snapshot_xmin(pg_current_snapshot())
```

Any row with `tx_id >= horizon` may still belong to an in-flight transaction.

### Safe position

Committed rows are those with `tx_id < pg_snapshot_xmin(pg_current_snapshot())`. Uncommitted rows from other backends are **not visible**, so we cannot scan in-flight inserts directly (including nextval-before-insert).

Let `upper = GREATEST(sequence.last_value, MAX(committed position))`. The first missing position in `1..upper` among committed rows is `gap`. Safe position is `gap - 1`, or `upper` if there is no gap.

- Example: S committed position 2, T still holds position 1 (not visible) → committed `{2}`, gap at 1 → safe = 0.
- After T commits → committed `{1,2}`, no gap → safe = 2.

Followers with `useSafePosition: true` only stream events with `global_position <= safe`.

### Performance

- One snapshot call per batch.
- `MIN(global_position) WHERE tx_id >= horizon` can use `idx_events_tx_id_position` (not a full-table `xmin` cast).
- No global append lock.

## Implementation

- `computeSafePosition()` in `src/store/safe-position.ts`
- `StreamOptions.useSafePosition` — projection loops set `true`
- `compileStreamQuery(..., maxPosition)` caps each batch

## Testing

`tests/integration/safe-position.test.ts` includes:

1. Classic T1 open / T2 commits first (insert-order race).
2. **Nextval-before-insert interleaving:** T reserves `p`, S reserves `q`, S inserts and commits while T still holds `p` — safe stays `< q` until T commits.
3. Checkpoint continuity with `afterPosition`.

## References

- PostgreSQL MVCC: https://www.postgresql.org/docs/current/mvcc.html
- `pg_current_xact_id()`, `pg_current_snapshot()`, `pg_snapshot_xmin()`
