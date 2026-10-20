import pg from 'pg';
import type { Query } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendCondition, StreamOptions, EventStore, TagExtractor } from '../types.js';
import { UNTAGGED } from '../types.js';
import {
  ConcurrencyError,
  EventStoreError,
  MissingTagExtractorError,
  EmptyBatchError,
  InconsistentStreamCursorError,
  InvalidTagError,
  LockTimeoutError,
  DeadlockError,
  SerializationFailureError,
  errorFromPg,
} from '../errors.js';
import {
  compileLoadCommittedQuery,
  compileExistsQuery,
  compileTailCommittedCursorQuery,
  compileStreamQuery,
  compileCommittedStreamQuery,
  compileAppendLockRequests,
  lockKeyString,
  compileStreamTagExistsQuery,
  streamTagsFromQuery,
} from '../query/compiler.js';
import { resolveAppendEvents, type ResolvedAppendEvent } from './resolve-event-tags.js';
import { applySchema } from './schema.js';
import { mapRow } from './row-mapper.js';
import { STREAM_CURSOR_ORIGIN, isConsistentStreamCursor } from '../types.js';
import type { StreamCursor } from '../types.js';
import { createObservability, type DcbObservability } from '../observability/index.js';
import type { ObservabilityConfig } from '../observability/index.js';
import { createAppendTelemetry, type AppendTelemetry } from '../observability/append-telemetry.js';

export interface EventStoreConfig {
  pool: pg.Pool;
  /**
   * OpenTelemetry (opt-in). Instrumentation runs only when `observability.enabled === true`.
   * Omitted or unset `enabled` → no-op without loading `@opentelemetry/api`.
   */
  observability?: ObservabilityConfig;
  /**
   * Tag extractors per event type.
   * Called for each event to derive tags from the event data.
   * Tags are merged with event.tags (if present) and deduplicated.
   *
   * Use the UNTAGGED symbol to mark event types that are intentionally untagged:
   * @example
   * tagExtractors: {
   *   OrderCreated: (event) => [`order:${event.data.orderId}`],
   *   SystemEvent: UNTAGGED,  // intentionally has no tags
   * }
   */
  tagExtractors?: Record<string, TagExtractor | typeof UNTAGGED>;
}

export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool;
  private readonly tagExtractors: Record<string, TagExtractor | typeof UNTAGGED>;
  private readonly observability: DcbObservability;
  private readonly appendTelemetry: AppendTelemetry | undefined;

  constructor(config: EventStoreConfig) {
    this.pool = config.pool;
    this.tagExtractors = config.tagExtractors ?? {};
    this.observability = createObservability(config.observability);
    this.appendTelemetry = this.observability.enabled
      ? createAppendTelemetry(this.observability)
      : undefined;
  }

  async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await applySchema(client);
    } finally {
      client.release();
    }
  }

  async load(query: Query): Promise<LoadResult> {
    const client = await this.pool.connect();
    let readXmin: string;
    let result: pg.QueryResult;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const xminResult = await client.query<{ xmin: string }>(
        'SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin',
      );
      readXmin = xminResult.rows[0]!.xmin;
      const { sql, params } = compileLoadCommittedQuery(query);
      result = await client.query(sql, params as unknown[]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new EventStoreError(`Failed to load events: ${String(err)}`, err);
    } finally {
      client.release();
    }
    const events: StoredEvent[] = result.rows.map(mapRow);
    const position: StreamCursor =
      events.length > 0
        ? {
            txId: events[events.length - 1]!.txId,
            globalPosition: events[events.length - 1]!.globalPosition,
            readXmin,
          }
        : { ...STREAM_CURSOR_ORIGIN, readXmin };
    return { events, position };
  }

  /**
   * Persist one or more events atomically.
   *
   * With `condition`, DCB concurrency is enforced (locks + failIfEventsMatch).
   * Without `condition`, the batch is still atomic but **not** isolated from
   * concurrent writers — callers must not use an unconditional append to
   * protect a business invariant.
   *
   * Empty arrays throw `EmptyBatchError`. PostgreSQL lock timeout, deadlock,
   * and serialization failures surface as `LockTimeoutError`, `DeadlockError`,
   * and `SerializationFailureError` (retryable). `ConcurrencyError` is an
   * application-level condition failure (do not blindly retry without reload).
   */
  async append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]> {
    const eventList = Array.isArray(events) ? events : [events];
    if (eventList.length === 0) {
      throw new EmptyBatchError();
    }
    if (condition?.after !== undefined && !isConsistentStreamCursor(condition.after)) {
      throw new InconsistentStreamCursorError(condition.after);
    }
    const resolved = resolveAppendEvents(eventList, this.tagExtractors);
    const run = () => this.appendToDatabase(resolved, condition);
    if (this.appendTelemetry === undefined) {
      return run();
    }
    return this.appendTelemetry.runAppend(eventList, condition, async (hooks) => {
      const stored = await this.appendToDatabase(resolved, condition, hooks);
      hooks.onEventsStored(stored);
      return stored;
    });
  }

  private async appendToDatabase(
    resolved: ResolvedAppendEvent[],
    condition: AppendCondition | undefined,
    hooks?: { runAcquireLocks: (pairCount: number, acquire: () => Promise<void>) => Promise<void> },
  ): Promise<StoredEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (condition !== undefined) {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");

        const lockRequests = compileAppendLockRequests(
          condition.failIfEventsMatch,
          resolved.map((r) => ({ type: r.event.type, tags: r.tags })),
        );
        const acquireLocks = async () => {
          for (const request of lockRequests) {
            const sql =
              request.mode === 'shared'
                ? 'SELECT pg_advisory_xact_lock_shared(hashtext($1))'
                : 'SELECT pg_advisory_xact_lock(hashtext($1))';
            await client.query(sql, [lockKeyString(request.key)]);
          }
        };

        if (hooks !== undefined) {
          await hooks.runAcquireLocks(lockRequests.length, acquireLocks);
        } else {
          await acquireLocks();
        }

        const conditionViolated = await this.appendConditionViolated(client, condition);
        if (conditionViolated) {
          const { sql: tailSql, params: tailParams } = compileTailCommittedCursorQuery(
            condition.failIfEventsMatch,
          );
          const tailResult = await client.query<{ tx_id: string; global_position: string }>(
            tailSql,
            tailParams as unknown[],
          );
          const tailRow = tailResult.rows[0];
          const actualPosition: StreamCursor = tailRow
            ? { txId: tailRow.tx_id, globalPosition: BigInt(tailRow.global_position) }
            : STREAM_CURSOR_ORIGIN;

          await client.query('ROLLBACK');
          throw new ConcurrencyError(
            condition.after ?? STREAM_CURSOR_ORIGIN,
            actualPosition,
            'Append condition failed: matching events exist after specified position',
          );
        }
      }

      const stored: StoredEvent[] = [];
      for (const { event, tags: finalTags } of resolved) {
        const sql = `INSERT INTO events (type, data, metadata, tags)
        VALUES ($1, $2::jsonb, $3::jsonb, $4)
        RETURNING global_position, event_id, type, data, metadata, occurred_at, tags, tx_id`.trim();
        const params = [event.type, event.data, event.metadata ?? null, finalTags];
        let result: pg.QueryResult;
        try {
          result = await client.query(sql, params);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new EventStoreError(`Failed to append event: ${String(err)}`, err);
        }
        stored.push(mapRow(result.rows[0]!));
      }

      await client.query('COMMIT');
      return stored;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (
        err instanceof EventStoreError ||
        err instanceof ConcurrencyError ||
        err instanceof MissingTagExtractorError ||
        err instanceof EmptyBatchError ||
        err instanceof InconsistentStreamCursorError ||
        err instanceof InvalidTagError
      ) {
        throw err;
      }
      const mapped = errorFromPg(err);
      if (
        mapped instanceof LockTimeoutError ||
        mapped instanceof DeadlockError ||
        mapped instanceof SerializationFailureError
      ) {
        throw mapped;
      }
      throw new EventStoreError(`Failed to append events: ${String(err)}`, err);
    } finally {
      client.release();
    }
  }

  async *stream(query: Query, options: StreamOptions = {}): AsyncGenerator<StoredEvent> {
    const batchSize = options.batchSize ?? 100;

    if (options.committedOnly) {
      let cursor: StreamCursor = options.afterCursor ?? STREAM_CURSOR_ORIGIN;

      while (true) {
        const { sql, params } = compileCommittedStreamQuery(query, cursor, batchSize);
        let result: pg.QueryResult;
        try {
          result = await this.pool.query(sql, params as unknown[]);
        } catch (err) {
          throw new EventStoreError(`Failed to stream events: ${String(err)}`, err);
        }

        for (const row of result.rows) {
          const event = mapRow(row);
          yield event;
          cursor = { txId: event.txId, globalPosition: event.globalPosition };
        }

        if (result.rowCount === null || result.rowCount < batchSize) break;
      }
      return;
    }

    let lastPosition = options.afterPosition ?? 0n;

    while (true) {
      const { sql, params } = compileStreamQuery(query, lastPosition, batchSize);
      let result: pg.QueryResult;
      try {
        result = await this.pool.query(sql, params as unknown[]);
      } catch (err) {
        throw new EventStoreError(`Failed to stream events: ${String(err)}`, err);
      }

      for (const row of result.rows) {
        const event = mapRow(row);
        yield event;
        lastPosition = event.globalPosition;
      }

      if (result.rowCount === null || result.rowCount < batchSize) break;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async appendConditionViolated(
    client: pg.PoolClient,
    condition: AppendCondition,
  ): Promise<boolean> {
    const { sql, params } = compileExistsQuery(condition.failIfEventsMatch, condition.after);
    const failIfResult = await client.query<{ exists: boolean }>(sql, params as unknown[]);
    if (failIfResult.rows[0]!.exists) {
      return true;
    }

    const streamTags = streamTagsFromQuery(condition.failIfEventsMatch);
    // Cross-type races on one tag (single-item failIf): any event on that tag after the cursor.
    // Multi-item / multi-tag conditions use typed failIf + locks only.
    if (streamTags.length === 1 && condition.failIfEventsMatch.items.length === 1) {
      const tagExists = compileStreamTagExistsQuery(streamTags[0]!, condition.after);
      const tagResult = await client.query<{ exists: boolean }>(
        tagExists.sql,
        tagExists.params as unknown[],
      );
      if (tagResult.rows[0]!.exists) {
        return true;
      }
    }
    return false;
  }
}
