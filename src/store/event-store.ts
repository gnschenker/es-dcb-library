import pg from 'pg';
import type { QueryDefinition } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore } from '../types.js';
import { ConcurrencyError, EventStoreError } from '../errors.js';
import { compileLoadQuery, compileVersionCheckQuery, compileCanonicalKey, compileStreamQuery } from '../query/compiler.js';
import { applySchema } from './schema.js';
import { mapRow } from './row-mapper.js';

export interface EventStoreConfig {
  pool: pg.Pool;
}

export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool;

  constructor(config: EventStoreConfig) {
    this.pool = config.pool;
  }

  async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await applySchema(client);
    } finally {
      client.release();
    }
  }

  async load(query: QueryDefinition): Promise<LoadResult> {
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

  async append(events: NewEvent | NewEvent[], options?: AppendOptions): Promise<StoredEvent[]> {
    const eventList = Array.isArray(events) ? events : [events];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (options !== undefined) {
        // Set session-local timeouts (reset automatically on COMMIT/ROLLBACK)
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");

        // Acquire per-stream advisory lock (non-blocking)
        const lockQuery = options.concurrencyQuery ?? options.query;
        const canonicalKey = compileCanonicalKey(lockQuery);
        const lockResult = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
          [canonicalKey]
        );
        const acquired = lockResult.rows[0]!.acquired;
        if (!acquired) {
          await client.query('ROLLBACK');
          throw new ConcurrencyError(
            options.expectedVersion,
            options.expectedVersion,
            'Advisory lock could not be acquired — another writer holds the lock'
          );
        }

        // Version check
        const versionQuery = options.concurrencyQuery ?? options.query;
        const { sql: versionSql, params: versionParams } = compileVersionCheckQuery(versionQuery);
        const versionResult = await client.query<{ max_pos: string }>(versionSql, versionParams as unknown[]);
        const actualVersion = BigInt(versionResult.rows[0]!.max_pos);
        if (actualVersion !== options.expectedVersion) {
          await client.query('ROLLBACK');
          throw new ConcurrencyError(options.expectedVersion, actualVersion);
        }
      }

      // Insert all events
      const stored: StoredEvent[] = [];
      for (const event of eventList) {
        const sql = `INSERT INTO events (type, payload, metadata)
        VALUES ($1, $2::jsonb, $3::jsonb)
        RETURNING global_position, event_id, type, payload, metadata, occurred_at`.trim();
        const params = [event.type, event.payload, event.metadata ?? null];
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

  async *stream(query: QueryDefinition, options: StreamOptions = {}): AsyncGenerator<StoredEvent> {
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
