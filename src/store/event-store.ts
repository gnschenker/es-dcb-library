import pg from 'pg';
import type { Query } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendCondition, StreamOptions, EventStore, TagExtractor } from '../types.js';
import { UNTAGGED } from '../types.js';
import { ConcurrencyError, EventStoreError, MissingTagExtractorError } from '../errors.js';
import {
  compileLoadQuery,
  compileExistsQuery,
  compileVersionCheckQuery,
  compileStreamQuery,
  compileCommittedStreamQuery,
  extractLockPairs,
} from '../query/compiler.js';
import { applySchema } from './schema.js';
import { mapRow } from './row-mapper.js';
import { STREAM_CURSOR_ORIGIN } from '../types.js';
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
    const { sql, params } = compileLoadQuery(query);
    let result: pg.QueryResult;
    try {
      result = await this.pool.query(sql, params as unknown[]);
    } catch (err) {
      throw new EventStoreError(`Failed to load events: ${String(err)}`, err);
    }
    const events: StoredEvent[] = result.rows.map(mapRow);
    const version: bigint = events.length > 0
      ? events[events.length - 1]!.globalPosition
      : 0n;
    return { events, version };
  }

  async append(events: NewEvent | NewEvent[], condition?: AppendCondition): Promise<StoredEvent[]> {
    const eventList = Array.isArray(events) ? events : [events];
    const run = () => this.appendToDatabase(eventList, condition);
    if (this.appendTelemetry === undefined) {
      return run();
    }
    return this.appendTelemetry.runAppend(eventList, condition, async (hooks) => {
      const stored = await this.appendToDatabase(eventList, condition, hooks);
      hooks.onEventsStored(stored);
      return stored;
    });
  }

  private async appendToDatabase(
    eventList: NewEvent[],
    condition: AppendCondition | undefined,
    hooks?: { runAcquireLocks: (pairCount: number, acquire: () => Promise<void>) => Promise<void> },
  ): Promise<StoredEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (condition !== undefined) {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");

        const lockPairs = extractLockPairs(condition.failIfEventsMatch);
        const acquireLocks = async () => {
          for (const { type, tag } of lockPairs) {
            const lockKey = `${type}:${tag}`;
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
          }
        };

        if (hooks !== undefined) {
          await hooks.runAcquireLocks(lockPairs.length, acquireLocks);
        } else {
          await acquireLocks();
        }

        const { sql: existsSql, params: existsParams } = compileExistsQuery(
          condition.failIfEventsMatch,
          condition.after,
        );
        const existsResult = await client.query<{ exists: boolean }>(existsSql, existsParams as unknown[]);

        if (existsResult.rows[0]!.exists) {
          const { sql: versionSql, params: versionParams } = compileVersionCheckQuery(
            condition.failIfEventsMatch,
          );
          const versionResult = await client.query<{ max_pos: string }>(versionSql, versionParams as unknown[]);
          const actualVersion = BigInt(versionResult.rows[0]!.max_pos);

          await client.query('ROLLBACK');
          throw new ConcurrencyError(
            condition.after ?? 0n,
            actualVersion,
            'Append condition failed: matching events exist after specified position',
          );
        }
      }

      const stored: StoredEvent[] = [];
      for (const event of eventList) {
        const eventTags = event.tags ?? [];
        const extractorOrMarker = this.tagExtractors[event.type];

        let extractedTags: string[] = [];

        if (extractorOrMarker === UNTAGGED) {
          extractedTags = [];
        } else if (typeof extractorOrMarker === 'function') {
          extractedTags = extractorOrMarker(event);
        } else if (eventTags.length === 0) {
          throw new MissingTagExtractorError(
            event.type,
            `Event type '${event.type}' has no registered tag extractor and no explicit tags were provided. ` +
            `Either register a tag extractor, mark it as UNTAGGED, or pass tags explicitly in the event.`,
          );
        }

        const finalTags = [...new Set([...eventTags, ...extractedTags])];

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
      if (!(err instanceof EventStoreError) && !(err instanceof ConcurrencyError) && !(err instanceof MissingTagExtractorError)) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new EventStoreError(`Failed to append events: ${String(err)}`, err);
      }
      throw err;
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
}
