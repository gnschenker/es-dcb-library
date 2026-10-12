import type { Meter, MeterProvider, Tracer, TracerProvider } from '@opentelemetry/api';

export interface ObservabilityConfig {
  /**
   * Must be `true` to enable instrumentation. Omitted, `false`, or any other value keeps
   * the library on the local no-op path (no `@opentelemetry/api` load, no global providers).
   */
  enabled?: boolean;
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  tracer?: Tracer;
  meter?: Meter;
}
