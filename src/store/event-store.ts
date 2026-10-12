import pg from 'pg';
import type { Query } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendCondition, StreamOptions, EventStore, TagExtractor } from '../types.js';
import { ConcurrencyError, EventStoreError } from '../errors.js';
import { compileLoadQuery, compileExistsQuery, compileStreamQuery, extractLockPairs } from '../query/compiler.js';
import { applySchema } from './schema.js';
import { mapRow } from './row-mapper.js';

export interface EventStoreConfig {
  pool: pg.Pool;
  /**
   * Tag extractors per event type.
   * Called for each event to derive tags from the event data.
   * Tags are merged with event.tags (if present) and deduplicated.
   */
  tagExtractors?: Record<string, TagExtractor>;
}

export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool;
  private readonly tagExtractors: Record<string, TagExtractor>;

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
        const lockPairs = extractLockPairs(condition.failIfEventsMatch);
        for (const { type, tag } of lockPairs) {
          const lockKey = `${type}:${tag}`;
          
          // Try to acquire lock with retry (exponential backoff)
          let acquired = false;
          const maxRetries = 3;
          const delays = [50, 200, 800]; // milliseconds
          
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const lockResult = await client.query<{ acquired: boolean }>(
              'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
              [lockKey]
            );
            acquired = lockResult.rows[0]!.acquired;
            
            if (acquired) {
              break;
            }
            
            // If not acquired and we have retries left, wait and try again
            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, delays[attempt]));
            }
          }
          
          if (!acquired) {
            await client.query('ROLLBACK');
            throw new ConcurrencyError(
              condition.after ?? 0n,
              condition.after ?? 0n,
              `Advisory lock could not be acquired for ${lockKey} after ${maxRetries} retries`
            );
          }
        }

        // Check append condition: fail if any matching event exists after the specified position
        const { sql: existsSql, params: existsParams } = compileExistsQuery(
          condition.failIfEventsMatch,
          condition.after
        );
        const existsResult = await client.query<{ exists: boolean }>(existsSql, existsParams as unknown[]);
        
        if (existsResult.rows[0]!.exists) {
          await client.query('ROLLBACK');
          const actualVersion = condition.after ?? 0n; // We don't know the exact version, but we know it's > after
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
        const extractor = this.tagExtractors[event.type];
        const extractedTags = extractor ? extractor(event) : [];
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
      if (!(err instanceof EventStoreError) && !(err instanceof ConcurrencyError)) {
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
