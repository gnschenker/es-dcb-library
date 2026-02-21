import Fastify from 'fastify';
import type { EventStore } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerTeacherRoutes } from './routes/teachers.js';
import { registerCourseRoutes } from './routes/courses.js';
import { registerStudentRoutes } from './routes/students.js';

export function buildServer(store: EventStore, clock: Clock) {
  const app = Fastify({ logger: true });

  registerErrorHandler(app);

  const prefix = '/api/v1';

  app.register(async (instance) => {
    await registerTeacherRoutes(instance, store, clock);
    await registerCourseRoutes(instance, store, clock);
    await registerStudentRoutes(instance, store, clock);
  }, { prefix });

  return app;
}
