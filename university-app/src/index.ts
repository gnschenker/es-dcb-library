import pg from 'pg';
import { createStore } from './store.js';
import { systemClock } from './domain/clock.js';
import { buildServer } from './api/server.js';
import { ProjectionManager } from 'es-dcb-library/projections';
import { teachersProjection } from './features/teachers/read-model.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required');
  process.exit(1);
}

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

const store = createStore(DATABASE_URL);
await store.initializeSchema();

// Dedicated pool for read-model writes and projection checkpoints
const readPool = new pg.Pool({ connectionString: DATABASE_URL });

const manager = new ProjectionManager({
  pool: readPool,
  store,
  projections: [teachersProjection],
  onError: (name, err) => console.error(`[projections] "${name}" failed:`, err),
});
await manager.initialize();
manager.start();
// Block HTTP startup until all projections have caught up
await manager.waitUntilLive();

const app = buildServer(store, systemClock, readPool);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  await store.close();
  await readPool.end();
  process.exit(1);
}

process.on('SIGTERM', async () => {
  await manager.stop();
  await app.close();
  await readPool.end();
  await store.close();
});
