import pg from 'pg';
import type { Query } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendCondition, StreamOptions, EventStore, TagExtractor } from '../types.js';
import { UNTAGGED } from '../types.js';
import { ConcurrencyError, EventStoreError, MissingTagExtractorError } from '../errors.js';
import { compileLoadQuery, compileExistsQuery, compileVersionCheckQuery, compileStreamQuery, extractLockPairs } from '../query/compiler.js';
import { applySchema } from './schema.js';
import { mapRow } from './row-mapper.js';
import { computeSafePosition } from './safe-position.js';

export interface EventStoreConfig {
  pool: pg.Pool;
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

  constructor(config: EventStoreConfig) {
    this.pool = config.pool;
    this.tagExtractors = config.tagExtractors ?? {};
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (condition !== undefined) {
        // Set session-local timeouts
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");

        // Acquire advisory locks for all (type, tag) pairs in sorted order
        // Using blocking pg_advisory_xact_lock - will wait for locks held by other transactions
        const lockPairs = extractLockPairs(condition.failIfEventsMatch);
        for (const { type, tag } of lockPairs) {
          const lockKey = `${type}:${tag}`;
          
          // Blocking lock - waits until acquired or lock_timeout expires
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
        }

        // All locks acquired - now check append condition
        // If condition fails here, it's a real conflict (not lock contention)
        const { sql: existsSql, params: existsParams } = compileExistsQuery(
          condition.failIfEventsMatch,
          condition.after
        );
        const existsResult = await client.query<{ exists: boolean }>(existsSql, existsParams as unknown[]);
        
        if (existsResult.rows[0]!.exists) {
          // Fetch actual max position for error reporting
          const { sql: versionSql, params: versionParams } = compileVersionCheckQuery(
            condition.failIfEventsMatch
          );
          const versionResult = await client.query<{ max_pos: string }>(versionSql, versionParams as unknown[]);
          const actualVersion = BigInt(versionResult.rows[0]!.max_pos);
          
          await client.query('ROLLBACK');
          throw new ConcurrencyError(
            condition.after ?? 0n,
            actualVersion,
            'Append condition failed: matching events exist after specified position'
          );
        }
      }

      // Insert all events
      const stored: StoredEvent[] = [];
      for (const event of eventList) {
        // Compute final tags: merge event.tags with extracted tags
        const eventTags = event.tags ?? [];
        const extractorOrMarker = this.tagExtractors[event.type];
        
        let extractedTags: string[] = [];
        
        if (extractorOrMarker === UNTAGGED) {
          // Type is marked as intentionally untagged
          extractedTags = [];
        } else if (typeof extractorOrMarker === 'function') {
          // Extractor function exists
          extractedTags = extractorOrMarker(event);
        } else if (eventTags.length === 0) {
          // No extractor, no explicit tags -> fail loudly
          throw new MissingTagExtractorError(
            event.type,
            `Event type '${event.type}' has no registered tag extractor and no explicit tags were provided. ` +
            `Either register a tag extractor, mark it as UNTAGGED, or pass tags explicitly in the event.`
          );
        }
        // If eventTags.length > 0 but no extractor, allow it (explicit tags provided)
        
        const finalTags = [...new Set([...eventTags, ...extractedTags])]; // deduplicate

        const sql = `INSERT INTO events (type, data, metadata, tags)
        VALUES ($1, $2::jsonb, $3::jsonb, $4)
        RETURNING global_position, event_id, type, data, metadata, occurred_at, tags`.trim();
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
    const useSafePosition = options.useSafePosition ?? false;
    let lastPosition = options.afterPosition ?? 0n;

    while (true) {
      let maxPosition: bigint | undefined = undefined;
      
      if (useSafePosition) {
        // Query safe position from a pool connection
        const client = await this.pool.connect();
        try {
          maxPosition = await computeSafePosition(client);
        } finally {
          client.release();
        }
        
        // If lastPosition >= maxPosition, no new safe events to read yet
        if (lastPosition >= maxPosition) {
          break;
        }
      }
      
      const { sql, params } = compileStreamQuery(query, lastPosition, batchSize, maxPosition);
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
