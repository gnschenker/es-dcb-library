import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import pg from 'pg';
import { PostgresEventStore, applySchema, queryItem } from '../../src/index.js';

describe('Tag Extractor Investigation', () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;
  let store: PostgresEventStore;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:15-alpine')
      .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .start();

    const connectionString = `postgresql://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
    pool = new pg.Pool({ connectionString });
    
    const client = await pool.connect();
    await applySchema(client);
    client.release();

    store = new PostgresEventStore({
      pool,
      tagExtractors: {
        OrderCreated: (event) => {
          console.log('[EXTRACTOR] OrderCreated called with event:', JSON.stringify(event, null, 2));
          console.log('[EXTRACTOR] event.data:', event.data);
          console.log('[EXTRACTOR] event.data.orderId:', event.data['orderId']);
          const tag = `order:${event.data['orderId']}`;
          console.log('[EXTRACTOR] Returning tag:', tag);
          return [tag];
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await store?.close();
    await pool?.end();
    await container?.stop();
  });

  it('tag extractor should be called and tags should be queryable', async () => {
    console.log('\n=== APPENDING EVENT ===');
    await store.append({
      type: 'OrderCreated',
      data: { orderId: 'order-123', customerId: 'c1' },
    });
    console.log('=== APPEND COMPLETE ===\n');

    console.log('=== QUERYING WITH TAG ===');
    const result = await store.load(queryItem({ types: ['OrderCreated'], tags: ['order:order-123'] }));
    console.log('Query result:', JSON.stringify(result, null, 2));
    console.log('Events found:', result.events.length);
    if (result.events.length > 0) {
      console.log('First event tags:', result.events[0]!.tags);
    }
    console.log('=== QUERY COMPLETE ===\n');

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.tags).toContain('order:order-123');
  });

  it('query all events to see what tags were actually stored', async () => {
    const result = await store.load(queryItem({}));
    console.log('\n=== ALL EVENTS ===');
    console.log('Total events:', result.events.length);
    result.events.forEach((e, i) => {
      console.log(`Event ${i}:`, {
        type: e.type,
        data: e.data,
        tags: e.tags,
      });
    });
    console.log('=== END ALL EVENTS ===\n');
  });
});
