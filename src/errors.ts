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
  override readonly name = 'EventStoreError';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
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
