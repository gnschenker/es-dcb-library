import pg from "pg";
import type { QueryDefinition } from "../query/types.js";
import type { NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore } from "../types.js";
import { EventStoreError } from "../errors.js";
import { compileLoadQuery, compileStreamQuery } from "../query/compiler.js";
import { applySchema } from "./schema.js";
import { mapRow } from "./row-mapper.js";

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
    // options is accepted but ignored in T-10 (T-11 will add concurrency logic)
    void options;

    const eventList = Array.isArray(events) ? events : [events];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stored: StoredEvent[] = [];
      for (const event of eventList) {
        const sql = `INSERT INTO events (type, payload, metadata)
        VALUES ($1, $2::jsonb, $3::jsonb)
        RETURNING global_position, event_id, type, payload, metadata, occurred_at`.trim();
        const params = [
          event.type,
          event.payload,
          event.metadata ?? null,
        ];
        let result: pg.QueryResult;
        try {
          result = await client.query(sql, params);
        } catch (err) {
          await client.query("ROLLBACK");
          throw new EventStoreError(`Failed to append event: ${String(err)}`, err);
        }
        stored.push(mapRow(result.rows[0]!));
      }
      await client.query("COMMIT");
      return stored;
    } catch (err) {
      // If we have not already rolled back (non-EventStoreError path)
      if (!(err instanceof EventStoreError)) {
        await client.query("ROLLBACK").catch(() => undefined);
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
