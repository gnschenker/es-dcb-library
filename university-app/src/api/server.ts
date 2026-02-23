import Fastify from 'fastify';
import type pg from 'pg';
import type { EventStore } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerTeacherRoutes } from '../features/teachers/routes.js';
import { registerCourseRoutes } from '../features/courses/routes.js';
import { registerStudentRoutes } from '../features/students/routes.js';
import { registerEnrollmentRoutes } from '../features/enrollments/routes.js';

export function buildServer(store: EventStore, clock: Clock, readPool?: pg.Pool) {
  const app = Fastify({ logger: true });

  registerErrorHandler(app);

  const prefix = '/api/v1';

  app.register(async (instance) => {
    await registerTeacherRoutes(instance, store, clock, readPool);
    await registerCourseRoutes(instance, store, clock);
    await registerStudentRoutes(instance, store, clock);
    await registerEnrollmentRoutes(instance, store, clock);
  }, { prefix });

  return app;
}
