import type { Meter, MeterProvider, Tracer, TracerProvider } from '@opentelemetry/api';

export interface ObservabilityConfig {
  /**
   * When `false`, the library does not call OpenTelemetry APIs (fast path).
   * Default: `true` (uses global or configured providers; no-op if no SDK is registered).
   */
  enabled?: boolean;
  tracerProvider?: TracerProvider;
  meterProvider?: MeterProvider;
  tracer?: Tracer;
  meter?: Meter;
}
