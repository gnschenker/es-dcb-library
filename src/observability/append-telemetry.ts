import { createRequire } from 'node:module';
import type { NewEvent, StoredEvent, AppendCondition } from '../types.js';
import type { DcbObservability } from './create-observability.js';
import { buildAppendSpanAttributes, buildLockSpanAttributes } from './append-attributes.js';
import { LATENCY_BUCKET_BOUNDARIES_MS } from './latency-buckets.js';
import { ConcurrencyError } from '../errors.js';

function loadOtelApi(): typeof import('@opentelemetry/api') {
  return createRequire(import.meta.url)('@opentelemetry/api') as typeof import('@opentelemetry/api');
}

export interface AppendTelemetry {
  runAppend(
    eventList: NewEvent[],
    condition: AppendCondition | undefined,
    operation: (hooks: AppendOperationHooks) => Promise<StoredEvent[]>,
  ): Promise<StoredEvent[]>;
}

export interface AppendOperationHooks {
  runAcquireLocks(pairCount: number, acquire: () => Promise<void>): Promise<void>;
  onEventsStored(stored: StoredEvent[]): void;
}

export function createAppendTelemetry(obs: DcbObservability): AppendTelemetry {
  const api = loadOtelApi();
  const { trace, context, SpanStatusCode, SpanKind } = api;

  const appendDuration = obs.meter.createHistogram('es_dcb.append.duration', {
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKET_BOUNDARIES_MS },
  });
  const lockWaitDuration = obs.meter.createHistogram('es_dcb.lock.wait.duration', {
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKET_BOUNDARIES_MS },
  });
  const eventsAppended = obs.meter.createCounter('es_dcb.events.appended');
  const appendConflicts = obs.meter.createCounter('es_dcb.append.conflicts');
  const appendErrors = obs.meter.createCounter('es_dcb.append.errors');

  return {
    async runAppend(eventList, condition, operation) {
      const appendStart = performance.now();
      let tagCountTotal = 0;
      const span = obs.tracer.startSpan('es_dcb.append', {
        kind: SpanKind.CLIENT,
        attributes: buildAppendSpanAttributes(eventList, condition, 0),
      });

      return context.with(trace.setSpan(context.active(), span), async () => {
        try {
          const stored = await operation({
            runAcquireLocks: async (pairCount, acquire) => {
              const lockStart = performance.now();
              const lockSpan = obs.tracer.startSpan('es_dcb.acquire_locks', {
                kind: SpanKind.CLIENT,
                attributes: buildLockSpanAttributes(pairCount),
              });
              try {
                await context.with(trace.setSpan(context.active(), lockSpan), async () => {
                  await acquire();
                });
                lockSpan.setStatus({ code: SpanStatusCode.OK });
              } catch (err) {
                lockSpan.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: err instanceof Error ? err.message : String(err),
                });
                lockSpan.recordException(err as Error);
                throw err;
              } finally {
                lockSpan.end();
                lockWaitDuration.record(performance.now() - lockStart);
              }
            },
            onEventsStored: (storedEvents) => {
              tagCountTotal = storedEvents.reduce((sum, e) => sum + e.tags.length, 0);
              for (const e of storedEvents) {
                eventsAppended.add(1, { 'dcb.event.type': e.type });
              }
            },
          });

          span.setAttributes({
            'dcb.tags.count': tagCountTotal,
            'dcb.append.condition_outcome': 'success',
          });
          span.setStatus({ code: SpanStatusCode.OK });
          return stored;
        } catch (err) {
          if (err instanceof ConcurrencyError) {
            span.setAttributes({
              'dcb.append.condition_outcome': 'conflict',
            });
            appendConflicts.add(1);
            appendErrors.add(1, { 'error.type': 'ConcurrencyError' });
          } else {
            span.setAttributes({
              'dcb.append.condition_outcome': 'error',
            });
            const errorType = err instanceof Error ? err.constructor.name : 'Error';
            appendErrors.add(1, { 'error.type': errorType });
          }
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
          appendDuration.record(performance.now() - appendStart);
        }
      });
    },
  };
}
