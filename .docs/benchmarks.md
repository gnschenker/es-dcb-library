# Operational benchmarks

Baseline from `npm run bench` (testcontainers `postgres:15-alpine`, same path as integration tests). **Not a CI gate.** Re-run after schema or query-shape changes.

## Environment

| | |
| --- | --- |
| Captured | 2026-10-14T21:11:55Z |
| PostgreSQL | 15.19 (Alpine, `postgres:15-alpine` via testcontainers) |
| Node.js | 22.14.0 |
| Host | Cloud Agent VM (single-node, cold-ish cache) |

These are order-of-magnitude numbers, not a published SLA. A laptop or production RDS instance will differ.

## Throughput and latency

| Scenario | n | p50 (ms) | p95 (ms) | p99 (ms) | mean (ms) | throughput |
| --- | --- | --- | --- | --- | --- | --- |
| Unconditional sequential `append` | 400 | 1.53 | 2.30 | 2.72 | 1.51 | 662 appends/s |
| Conditional sequential `append` (load + append, same stream) | 200 | 2.42 | 3.33 | 5.64 | 2.56 | 283 appends/s |
| High-contention conditional `append` (8 writers × 5 rounds) | 40 | 7.44 | 34.27 | 42.98 | 11.00 | 445 attempts/s |
| `load()` of 2000 events | 2000 events | — | — | — | 6.42 | ~312k events/s |
| `stream({ committedOnly: true })` of 2000 events | 2000 events | — | — | — | 14.28 | ~140k events/s |

High-contention rounds: **5 successes / 35 conflicts** (exactly one winner per 8-way race). p95 is dominated by lock wait behind the winner.

Conditional sequential cost includes a `load()` per append (the supported command-handler pattern). Copying `readXmin` from an older load onto a newer event cursor is rejected as `InconsistentStreamCursorError` (see [v2-migration.md](./v2-migration.md)).

## Query-plan observations

`EXPLAIN` after the 2000-row history. Plans at this size are not representative of multi-million-row stores.

### Committed `load()` (`type = Hist` AND `tags @> {bench}` AND `tx_id < xmin`)

Uses `idx_events_type_position` (bitmap index scan on `type`), then filters `tags` and the xmin predicate. Sort on `(tx_id, global_position)`.

```
Sort
  Sort Key: tx_id, global_position
  ->  Bitmap Heap Scan on events
        Recheck Cond: ((type)::text = ANY ('{Hist}'::text[]))
        Filter: ((tags @> '{bench}'::text[]) AND (tx_id < pg_snapshot_xmin(pg_current_snapshot())))
        ->  Bitmap Index Scan on idx_events_type_position
              Index Cond: ((type)::text = ANY ('{Hist}'::text[]))
```

### Exists-after (`failIfEventsMatch` with `readXmin` late-commit holes)

Seq scan at 2000 rows. The `OR` of tuple-order vs `global_position < after AND tx_id >= readXmin` is a harder index shape than a plain `@>` + position predicate. At this cardinality the planner prefers a heap scan; GIN `tags` should matter once the table is large enough that seq scan cost grows.

```
Result
  InitPlan 1
    ->  Seq Scan on events
          Filter: ((tags @> '{bench}'::text[]) AND (
            ROW(tx_id, global_position) > ROW('1'::xid8, '1'::bigint)
            OR (global_position < '1'::bigint AND tx_id >= '1'::xid8)
          ))
```

### Committed stream from origin (`queryAll()`, batch 200)

Seq scan + sort + limit — expected when the query has no type/tag predicate.

```
Limit
  ->  Sort
        Sort Key: tx_id, global_position
        ->  Seq Scan on events
              Filter: ((ROW(tx_id, global_position) > ROW('0'::xid8, '0'::bigint))
                       AND (tx_id < pg_snapshot_xmin(pg_current_snapshot())))
```

## How to re-run

```bash
npm run bench
```

Requires Docker. Output is a JSON summary on stdout; update this file if the numbers move enough to change the story.
