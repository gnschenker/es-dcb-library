# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-20

### Fixed

- Advisory locks now key by tag (type ignored), by type when a condition has no tags, and by a global `all` key for match-all conditions. Each appended event takes exclusive tag and type locks plus a shared `all` lock (`pg_advisory_xact_lock_shared`). Writers whose conditions are written differently (for example `*:board:B1` vs `ChapterAdded:board:B1`) serialize, and a tagless type condition or `queryAll()` now collides with any matching append. A match-all condition takes exclusive `all`, so it serializes with every other **conditional** writer (unconditional `append()` still takes no DCB locks). Lock keys are acquired in locale-independent UTF-16 code-unit order.

## [1.0.0] - 2026-10-12

First stable release aligned with the [DCB specification](https://dcb.events).

**Runtime requirements:** Node.js 18+ and **PostgreSQL 13+**. The `tx_id` column (`xid8`, `pg_current_xact_id()`) and committed-only streaming (`pg_snapshot_xmin`) depend on PostgreSQL 13 or newer.

### Added

- **Tag-based query API**: `query()`, `queryItem()`, `queryAll()`, and `combineQueries()` for building `Query` objects (OR across items; AND within each item’s `types` / `tags`).
- **Tag extractors** on `PostgresEventStore`: per-event-type functions that derive tags from event `data`, merged with explicit `tags` on append.
- **Strict tag extraction**: `MissingTagExtractorError` when appending without a registered extractor, explicit tags, or `UNTAGGED` marker.
- **`UNTAGGED` symbol** to mark event types that intentionally carry no tags.
- **Spec-shaped append conditions**: `failIfEventsMatch` + optional `after` (replaces version/query options from 0.1.0).
- **Tag-based advisory locking** on `(type, tag)` pairs for overlapping consistency boundaries.
- **Projections addon** (`es-dcb-library/projections`): `defineProjection`, `createEventDispatcher`, `ProjectionManager` with catch-up, live `LISTEN/NOTIFY`, retries, and per-projection isolation.
- **Committed-only streaming** (`committedOnly: true`) with `(tx_id, global_position)` ordering and `StreamCursor` checkpoints for projection gap safety.
- **`tx_id` column** on events (PostgreSQL `xid8`, default `pg_current_xact_id()`) for committed-stream visibility (**requires PostgreSQL 13+**).
- **`applySchema`**, dual **ESM + CJS** builds, and TypeScript declarations for the main and `./projections` entry points.

### Changed

- **Breaking**: Removed the payload-based fluent query DSL (`query.eventsOfType(...).where.key(...).equals(...)`).
- **Breaking**: Renamed event field `payload` → `data`.
- **Breaking**: Events require tags at the storage layer (`tags TEXT[] NOT NULL`); queries target tags instead of JSONB payload paths.
- **Breaking**: `AppendOptions` / `expectedVersion` replaced by `AppendCondition` (`failIfEventsMatch`, `after`).
- **Breaking**: `store.append()` returns `Promise<StoredEvent[]>` (stored rows including `globalPosition` and `txId`).
- **Breaking**: `StoredEvent` includes `txId` when read from the database.
- Removed GIN index on event `data`; added GIN index on `tags`.
- Projections use committed-only streaming and cursor-based checkpoints (`last_tx_id`, `last_position`).

### Removed

- Payload-key query compiler and related builder types from 0.1.0.

[1.0.1]: https://github.com/gnschenker/es-dcb-library/releases/tag/v1.0.1
[1.0.0]: https://github.com/gnschenker/es-dcb-library/releases/tag/v1.0.0
