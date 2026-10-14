import type { StreamCursor } from './types.js';

export class ConcurrencyError extends Error {
  override readonly name = 'ConcurrencyError';

  constructor(
    readonly expectedPosition: StreamCursor,
    readonly actualPosition: StreamCursor,
    message?: string,
  ) {
    super(
      message ??
        `Concurrency conflict: expected stream at (${expectedPosition.txId}, ${expectedPosition.globalPosition}), ` +
          `actual (${actualPosition.txId}, ${actualPosition.globalPosition})`,
    );
    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EventStoreError extends Error {
  override readonly name: string = 'EventStoreError';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InconsistentStreamCursorError extends Error {
  override readonly name = 'InconsistentStreamCursorError';

  constructor(
    readonly cursor: StreamCursor,
    message?: string,
  ) {
    super(
      message ??
        `StreamCursor.readXmin ${JSON.stringify(cursor.readXmin)} is not consistent with txId ${JSON.stringify(cursor.txId)}. ` +
          'load() positions always have txId < readXmin (committed-visible events). ' +
          'Pass load().position unchanged, or eventStreamCursor(event) without a foreign readXmin.',
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EmptyBatchError extends Error {
  override readonly name = 'EmptyBatchError';

  constructor(message?: string) {
    super(message ?? 'Cannot append an empty batch');
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidTagError extends Error {
  override readonly name = 'InvalidTagError';

  constructor(
    readonly tag: string,
    message?: string,
  ) {
    super(message ?? `Invalid event tag ${JSON.stringify(tag)}: tags must be non-empty strings`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** PostgreSQL lock_timeout / lock_not_available (55P03). Retryable. */
export class LockTimeoutError extends EventStoreError {
  override readonly name = 'LockTimeoutError';

  constructor(message?: string, cause?: unknown) {
    super(message ?? 'Database lock timeout', cause);
  }
}

/** PostgreSQL deadlock_detected (40P01). Retryable. */
export class DeadlockError extends EventStoreError {
  override readonly name = 'DeadlockError';

  constructor(message?: string, cause?: unknown) {
    super(message ?? 'Database deadlock detected', cause);
  }
}

/** PostgreSQL serialization_failure (40001). Retryable. */
export class SerializationFailureError extends EventStoreError {
  override readonly name = 'SerializationFailureError';

  constructor(message?: string, cause?: unknown) {
    super(message ?? 'Serialization failure', cause);
  }
}

export class ProjectionNotReadyError extends Error {
  override readonly name = 'ProjectionNotReadyError';

  constructor(
    message: string,
    readonly failedProjections: Array<{ name: string; status: string }> = [],
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProjectionSetupTimeoutError extends Error {
  override readonly name = 'ProjectionSetupTimeoutError';

  constructor(readonly projectionName: string, readonly timeoutMs: number) {
    super(`Projection "${projectionName}" setup() timed out after ${timeoutMs}ms`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const RETRYABLE_PG_CODES: Record<string, (message: string, cause: unknown) => Error> = {
  '55P03': (message, cause) => new LockTimeoutError(message, cause),
  '40P01': (message, cause) => new DeadlockError(message, cause),
  '40001': (message, cause) => new SerializationFailureError(message, cause),
};

/** Maps a pg error to a typed store error when the SQLSTATE is known. */
export function errorFromPg(err: unknown): Error {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const factory = code !== undefined ? RETRYABLE_PG_CODES[code] : undefined;
  if (factory !== undefined) {
    return factory(message, err);
  }
  if (err instanceof Error) {
    return err;
  }
  return new EventStoreError(message, err);
}

export class MissingTagExtractorError extends Error {
  override readonly name = 'MissingTagExtractorError';

  constructor(
    readonly eventType: string,
    message?: string,
  ) {
    super(message ?? `No tag extractor registered for event type '${eventType}' and no explicit tags provided. Either register a tag extractor or pass tags explicitly.`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
