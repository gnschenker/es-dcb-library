import { metrics, trace } from '@opentelemetry/api';
import type { Meter, Tracer } from '@opentelemetry/api';
import { disabledMeter, disabledTracer } from './noop.js';
import type { ObservabilityConfig } from './types.js';
import { INSTRUMENTATION_VERSION } from './version.js';

export const INSTRUMENTATION_SCOPE_NAME = 'es-dcb-library';

export interface DcbObservability {
  enabled: boolean;
  tracer: Tracer;
  meter: Meter;
}

/**
 * Resolves tracer and meter for library instrumentation.
 * When `config.enabled === false`, returns local no-op implementations without calling providers.
 */
export function createObservability(config?: ObservabilityConfig): DcbObservability {
  if (config?.enabled === false) {
    return {
      enabled: false,
      tracer: disabledTracer,
      meter: disabledMeter,
    };
  }

  const tracerProvider = config?.tracerProvider ?? trace.getTracerProvider();
  const meterProvider = config?.meterProvider ?? metrics.getMeterProvider();

  const tracer =
    config?.tracer ??
    tracerProvider.getTracer(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_VERSION);

  const meter =
    config?.meter ??
    meterProvider.getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_VERSION);

  return {
    enabled: true,
    tracer,
    meter,
  };
}
