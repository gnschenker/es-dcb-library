import { describe, it, expect, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { createObservability } from '../../src/observability/create-observability.js';
import { createAppendTelemetry } from '../../src/observability/append-telemetry.js';
import { buildAppendSpanAttributes } from '../../src/observability/append-attributes.js';
import { ConcurrencyError } from '../../src/errors.js';
import { STREAM_CURSOR_ORIGIN } from '../../src/types.js';
import { createTestOtelProviders } from '../helpers/otel-test-providers.js';
import { assertSpanAttributesSafe, findSpan } from '../helpers/telemetry-assertions.js';

describe('buildAppendSpanAttributes', () => {
  it('includes counts and types only', () => {
    const attrs = buildAppendSpanAttributes(
      [
        { type: 'OrderCreated', data: { orderId: 'secret-o1' }, tags: ['order:secret'] },
        { type: 'OrderShipped', data: {}, tags: ['order:secret'] },
      ],
      undefined,
      4,
    );
    expect(attrs['dcb.event.count']).toBe(2);
    expect(attrs['dcb.event.types']).toEqual(['OrderCreated', 'OrderShipped']);
    expect(attrs['dcb.tags.count']).toBe(4);
    expect(JSON.stringify(attrs)).not.toContain('secret');
    expect(attrs).not.toHaveProperty('data');
    expect(attrs).not.toHaveProperty('tags');
  });
});

describe('createAppendTelemetry', () => {
  it('records append and acquire_locks spans on success', async () => {
    const { spanExporter, tracerProvider, meterProvider, metricReader } = createTestOtelProviders();
    const obs = createObservability({
      enabled: true,
      tracerProvider,
      meterProvider,
    });
    const telemetry = createAppendTelemetry(obs);

    await telemetry.runAppend(
      [{ type: 'OrderCreated', data: { x: 1 }, tags: ['a', 'b'] }],
      undefined,
      async (hooks) => {
        const stored = [
          {
            globalPosition: 1n,
            eventId: 'id',
            type: 'OrderCreated',
            data: { x: 1 },
            metadata: null,
            occurredAt: new Date(),
            tags: ['a', 'b'],
            txId: '1',
          },
        ];
        hooks.onEventsStored(stored);
        return stored;
      },
    );

    await tracerProvider.forceFlush();
    const spans = spanExporter.getFinishedSpans();
    const appendSpan = findSpan(spans, 'es_dcb.append');
    const lockSpan = findSpan(spans, 'es_dcb.acquire_locks');
    expect(appendSpan).toBeDefined();
    expect(lockSpan).toBeUndefined();
    expect(appendSpan!.attributes['dcb.append.condition_outcome']).toBe('success');
    assertSpanAttributesSafe(appendSpan!);
    for (const span of spans) {
      assertSpanAttributesSafe(span);
    }

    await metricReader.forceFlush();
  });

  it('records conflict outcome and ERROR status for ConcurrencyError', async () => {
    const { spanExporter, tracerProvider, meterProvider } = createTestOtelProviders();
    const obs = createObservability({ enabled: true, tracerProvider, meterProvider });
    const telemetry = createAppendTelemetry(obs);

    await expect(
      telemetry.runAppend([{ type: 'E', data: {}, tags: ['t'] }], undefined, async () => {
        throw new ConcurrencyError(0n, 1n, 'conflict');
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);

    await tracerProvider.forceFlush();
    const appendSpan = findSpan(spanExporter.getFinishedSpans(), 'es_dcb.append');
    expect(appendSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(appendSpan?.attributes['dcb.append.condition_outcome']).toBe('conflict');
  });

  it('creates acquire_locks child span when locks run', async () => {
    const { spanExporter, tracerProvider, meterProvider } = createTestOtelProviders();
    const obs = createObservability({ enabled: true, tracerProvider, meterProvider });
    const telemetry = createAppendTelemetry(obs);
    const acquire = vi.fn().mockResolvedValue(undefined);

    await telemetry.runAppend(
      [{ type: 'E', data: {}, tags: ['x'] }],
      { failIfEventsMatch: { items: [{ types: ['E'], tags: ['x'] }] }, after: 0n },
      async (hooks) => {
        await hooks.runAcquireLocks(2, acquire);
        hooks.onEventsStored([]);
        return [];
      },
    );

    expect(acquire).toHaveBeenCalled();
    await tracerProvider.forceFlush();
    const lockSpan = findSpan(spanExporter.getFinishedSpans(), 'es_dcb.acquire_locks');
    expect(lockSpan).toBeDefined();
    expect(lockSpan!.attributes['dcb.lock.pair_count']).toBe(2);
    assertSpanAttributesSafe(lockSpan!);
  });
});

describe('PostgresEventStore append telemetry', () => {
  it('does not create spans when observability is disabled', async () => {
    const { spanExporter, tracerProvider, meterProvider } = createTestOtelProviders();
    const { PostgresEventStore } = await import('../../src/store/event-store.js');

    const insertRow = {
      global_position: '1',
      event_id: 'e1',
      type: 'OrderCreated',
      data: { a: 1 },
      metadata: null,
      occurred_at: new Date(),
      tags: ['t'],
      tx_id: '1',
    };
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO events')) {
        return { rows: [insertRow] };
      }
      return { rows: [] };
    });

    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) } as never;

    const storeOff = new PostgresEventStore({ pool });
    await storeOff.append({ type: 'OrderCreated', data: { a: 1 }, tags: ['t'] });
    expect(spanExporter.getFinishedSpans()).toHaveLength(0);

    const storeOn = new PostgresEventStore({
      pool,
      observability: { enabled: true, tracerProvider, meterProvider },
    });
    await storeOn.append({ type: 'OrderCreated', data: { a: 1 }, tags: ['t'] });
    await tracerProvider.forceFlush();
    expect(spanExporter.getFinishedSpans().some((s) => s.name === 'es_dcb.append')).toBe(true);
  });
});
