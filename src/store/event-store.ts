import pg from 'pg';
import type { QueryDefinition } from '../query/types.js';
import type { NewEvent, StoredEvent, LoadResult, AppendOptions, StreamOptions, EventStore } from '../types.js';
import { EventStoreError } from '../errors.js';
import { compileLoadQuery } from '../query/compiler.js';
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

  async append(_events: NewEvent | NewEvent[], _options?: AppendOptions): Promise<StoredEvent[]> {
    throw new Error('not implemented');
  }

  async *stream(_query: QueryDefinition, _options?: StreamOptions): AsyncGenerator<StoredEvent> {
    throw new Error('not implemented');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
