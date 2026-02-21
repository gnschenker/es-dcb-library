import type { FastifyInstance } from 'fastify';
import { ConcurrencyError, EventStoreError } from 'es-dcb-library';
import {
  TeacherNotFoundError,
  CourseNotFoundError,
  StudentNotFoundError,
} from '../../domain/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((unknownError, _request, reply) => {
    // Ensure we always deal with an Error object
    const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));

    // Concurrency conflict → 409 Conflict (retryable)
    if (error instanceof ConcurrencyError) {
      return reply.status(409).send({
        error: 'ConcurrencyError',
        retryable: true,
        hint: 'Reload and retry',
      });
    }

    // Resource not found → 404
    if (
      error instanceof TeacherNotFoundError ||
      error instanceof CourseNotFoundError ||
      error instanceof StudentNotFoundError
    ) {
      return reply.status(404).send({ error: error.name, message: error.message });
    }

    // Infrastructure errors → 500 (not 422 — these are not domain rule violations)
    if (error instanceof EventStoreError) {
      app.log.error(error);
      return reply.status(500).send({ error: 'InternalError', message: 'Internal server error' });
    }

    // Fastify built-in errors have a numeric `statusCode` — pass it through
    const isFastifyError = 'statusCode' in error &&
      typeof (error as Error & { statusCode?: unknown }).statusCode === 'number';
    if (isFastifyError) {
      const statusCode = (error as Error & { statusCode: number }).statusCode;
      return reply.status(statusCode).send({ error: error.name, message: error.message });
    }

    // Domain errors: named Error subclass (not a plain Error)
    if (error.constructor !== Error) {
      return reply.status(422).send({ error: error.name, message: error.message });
    }

    app.log.error(error);
    return reply.status(500).send({ error: 'InternalError', message: 'Internal server error' });
  });
}
