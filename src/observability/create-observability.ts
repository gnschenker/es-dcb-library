import { createRequire } from 'node:module';
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

function loadOtelApi(): typeof import('@opentelemetry/api') {
  try {
    return createRequire(import.meta.url)('@opentelemetry/api') as typeof import('@opentelemetry/api');
  } catch (err) {
    throw new Error(
      'observability.enabled is true but @opentelemetry/api is not installed. Add it as a dependency.',
      { cause: err },
    );
  }
}

/**
 * Resolves tracer and meter for library instrumentation.
 *
 * Opt-in only: instrumentation is active only when `config.enabled === true`.
 * Omitted config, `{}`, or any other value (including `enabled: false`) returns local
 * no-ops and does not load or call `@opentelemetry/api`.
 */
export function createObservability(config?: ObservabilityConfig): DcbObservability {
  if (config?.enabled !== true) {
    return {
      enabled: false,
      tracer: disabledTracer,
      meter: disabledMeter,
    };
  }

  const { trace, metrics } = loadOtelApi();

  const tracerProvider = config.tracerProvider ?? trace.getTracerProvider();
  const meterProvider = config.meterProvider ?? metrics.getMeterProvider();

  const tracer =
    config.tracer ??
    tracerProvider.getTracer(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_VERSION);

  const meter =
    config.meter ??
    meterProvider.getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_VERSION);

  return {
    enabled: true,
    tracer,
    meter,
  };
}
