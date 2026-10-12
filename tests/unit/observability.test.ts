import { describe, it, expect, vi } from 'vitest';
import { trace, metrics, SpanKind } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createObservability,
  INSTRUMENTATION_SCOPE_NAME,
  INSTRUMENTATION_VERSION,
} from '../../src/observability/index.js';
import { disabledTracer } from '../../src/observability/noop.js';

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { version: string };

describe('createObservability', () => {
  it('exposes instrumentation scope name and package version', () => {
    expect(INSTRUMENTATION_SCOPE_NAME).toBe('es-dcb-library');
    expect(INSTRUMENTATION_VERSION).toBe(packageJson.version);
  });

  it('when enabled is false, does not call tracer or meter providers', () => {
    const getTracer = vi.fn();
    const getMeter = vi.fn();
    const obs = createObservability({
      enabled: false,
      tracerProvider: { getTracer },
      meterProvider: { getMeter },
    });

    expect(obs.enabled).toBe(false);
    expect(obs.tracer).toBe(disabledTracer);
    expect(getTracer).not.toHaveBeenCalled();
    expect(getMeter).not.toHaveBeenCalled();
    obs.tracer.startSpan('test');
  });

  it('acquires tracer and meter with scope name and version from providers', () => {
    const exporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const meterProvider = new MeterProvider();

    const obs = createObservability({ tracerProvider, meterProvider });

    expect(obs.enabled).toBe(true);
    const span = obs.tracer.startSpan('es_dcb.test', { kind: SpanKind.INTERNAL });
    span.end();
    tracerProvider.forceFlush?.();

    const ended = exporter.getFinishedSpans();
    expect(ended).toHaveLength(1);
    expect(ended[0]?.name).toBe('es_dcb.test');

    const meter = obs.meter;
    expect(meter).toBeDefined();
    meter.createCounter('es_dcb.test.counter');
  });

  it('uses explicit tracer and meter when provided', () => {
    const customTracer = trace.getTracer('custom');
    const customMeter = metrics.getMeter('custom');
    const getTracer = vi.fn();
    const obs = createObservability({
      tracer: customTracer,
      meter: customMeter,
      tracerProvider: { getTracer },
    });
    expect(obs.tracer).toBe(customTracer);
    expect(getTracer).not.toHaveBeenCalled();
  });
});

