import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresEventStore, queryItem, STREAM_CURSOR_ORIGIN } from '../../src/index.js';
import { createTestOtelProviders } from '../helpers/otel-test-providers.js';
import { assertSpanAttributesSafe, findSpan } from '../helpers/telemetry-assertions.js';
import { createTestPool, resetDatabase } from './helpers.js';

let pool: pg.Pool;
const { spanExporter, tracerProvider, meterProvider } = createTestOtelProviders();

beforeEach(async () => {
  if (!pool) pool = createTestPool();
  await resetDatabase(pool);
  spanExporter.reset();
});

afterAll(async () => {
  await pool?.end();
});

describe('append OpenTelemetry (integration)', () => {
  it('emits es_dcb.append span without payload or tag values in attributes', async () => {
    const store = new PostgresEventStore({
      pool,
      observability: { enabled: true, tracerProvider, meterProvider },
      tagExtractors: {
        OrderCreated: (e) => [`order:${(e.data as { orderId: string }).orderId}`],
      },
    });

    await store.append({
      type: 'OrderCreated',
      data: { orderId: 'sensitive-order-99' },
    });

    await tracerProvider.forceFlush();
    const appendSpan = findSpan(spanExporter.getFinishedSpans(), 'es_dcb.append');
    expect(appendSpan).toBeDefined();
    expect(appendSpan!.attributes['dcb.event.types']).toEqual(['OrderCreated']);
    expect(JSON.stringify(appendSpan!.attributes)).not.toContain('sensitive-order-99');
    assertSpanAttributesSafe(appendSpan!);
  });

  it('sets condition_outcome conflict on ConcurrencyError', async () => {
    const store = new PostgresEventStore({
      pool,
      observability: { enabled: true, tracerProvider, meterProvider },
    });

    const q = queryItem({ types: ['OrderCreated'], tags: ['order:o1'] });
    await store.append({ type: 'OrderCreated', data: {}, tags: ['order:o1'] });
    spanExporter.reset();

    await expect(
      store.append(
        { type: 'OrderCreated', data: {}, tags: ['order:o1'] },
        { failIfEventsMatch: q, after: STREAM_CURSOR_ORIGIN },
      ),
    ).rejects.toThrow(/Append condition failed/);

    await tracerProvider.forceFlush();
    const appendSpan = findSpan(spanExporter.getFinishedSpans(), 'es_dcb.append');
    expect(appendSpan?.attributes['dcb.append.condition_outcome']).toBe('conflict');
  });
});
