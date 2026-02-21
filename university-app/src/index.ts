import { createStore } from './store.js';
import { systemClock } from './domain/clock.js';
import { buildServer } from './api/server.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  process.exit(1);
}

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const store = createStore(DATABASE_URL);
await store.initializeSchema();

const app = buildServer(store, systemClock);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  await store.close();
  process.exit(1);
}
