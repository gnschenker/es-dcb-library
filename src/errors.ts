export class ConcurrencyError extends Error {
  override readonly name = 'ConcurrencyError';

  constructor(
    readonly expectedVersion: bigint,
    readonly actualVersion: bigint,
    message?: string,
  ) {
    super(message ?? `Concurrency conflict: expected version ${expectedVersion}, got ${actualVersion}`);
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
