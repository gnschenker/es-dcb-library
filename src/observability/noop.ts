import type { Meter, Span, Tracer } from '@opentelemetry/api';

const disabledSpan: Span = {
  spanContext() {
    return { traceId: '00000000000000000000000000000000', spanId: '0000000000000000', traceFlags: 0 };
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  setStatus() {
    return this;
  },
  updateName() {
    return this;
  },
  end() {},
  isRecording() {
    return false;
  },
  recordException() {},
  addLink() {
    return this;
  },
  addLinks() {
    return this;
  },
};

function runWithDisabledSpan<T>(fn: (span: Span) => T): T {
  return fn(disabledSpan);
}

/** No OpenTelemetry provider calls when observability is disabled. */
export const disabledTracer: Tracer = {
  startSpan() {
    return disabledSpan;
  },
  startActiveSpan(...args: unknown[]): unknown {
    const fn = args[args.length - 1];
    if (typeof fn === 'function') {
      return runWithDisabledSpan(fn as (span: Span) => unknown);
    }
    return disabledSpan;
  },
};

const disabledInstrument = {
  add() {},
  record() {},
};

const disabledObservable = {
  addCallback() {},
  removeCallback() {},
};

/** No provider calls when observability is disabled. */
export const disabledMeter: Meter = {
  createHistogram() {
    return disabledInstrument;
  },
  createCounter() {
    return disabledInstrument;
  },
  createUpDownCounter() {
    return disabledInstrument;
  },
  createObservableGauge() {
    return disabledObservable;
  },
  createObservableCounter() {
    return disabledObservable;
  },
  createObservableUpDownCounter() {
    return disabledObservable;
  },
  createGauge() {
    return disabledInstrument;
  },
  addBatchObservableCallback() {},
  removeBatchObservableCallback() {},
};
