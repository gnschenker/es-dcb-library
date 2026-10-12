import { createObservability, PostgresEventStore } from '../../dist/index.js';

const obs = createObservability();
if (!obs.enabled) {
  // no-op path
}

const pool = {};
new PostgresEventStore({ pool });
