import { describe, it, expect } from 'vitest';
import { ConcurrencyError, EventStoreError } from '../../src/errors.js';

describe('ConcurrencyError', () => {
  it('constructs without error', () => {
    expect(() => new ConcurrencyError(1n, 2n)).not.toThrow();
  });

  it('has correct name', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err.name).toBe('ConcurrencyError');
  });

  it('stores expectedVersion as bigint', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err.expectedVersion).toBe(1n);
    expect(typeof err.expectedVersion).toBe('bigint');
  });

  it('stores actualVersion as bigint', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err.actualVersion).toBe(2n);
    expect(typeof err.actualVersion).toBe('bigint');
  });

  it('is instanceof ConcurrencyError', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err).toBeInstanceOf(ConcurrencyError);
  });

  it('is instanceof Error', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err).toBeInstanceOf(Error);
  });

  it('generates a default message when none provided', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err.message).toBeTruthy();
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('uses custom message when provided', () => {
    const err = new ConcurrencyError(1n, 2n, 'my message');
    expect(err.message).toBe('my message');
  });

  it('has a stack trace', () => {
    const err = new ConcurrencyError(1n, 2n);
    expect(err.stack).toBeDefined();
  });

  it('works with version 0n', () => {
    const err = new ConcurrencyError(0n, 0n);
    expect(err.expectedVersion).toBe(0n);
    expect(err.actualVersion).toBe(0n);
  });

  it('works with very large bigint versions', () => {
    const big = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
    const err = new ConcurrencyError(big, big + 1n);
    expect(err.expectedVersion).toBe(big);
    expect(err.actualVersion).toBe(big + 1n);
  });
});

describe('EventStoreError', () => {
  it('constructs without error', () => {
    expect(() => new EventStoreError('something went wrong')).not.toThrow();
  });

  it('has correct name', () => {
    const err = new EventStoreError('msg');
    expect(err.name).toBe('EventStoreError');
  });

  it('is instanceof EventStoreError', () => {
    const err = new EventStoreError('msg');
    expect(err).toBeInstanceOf(EventStoreError);
  });

  it('is instanceof Error', () => {
    const err = new EventStoreError('msg');
    expect(err).toBeInstanceOf(Error);
  });

  it('cause is undefined when not provided', () => {
    const err = new EventStoreError('msg');
    expect(err.cause).toBeUndefined();
  });

  it('stores the cause when provided', () => {
    const root = new Error('root');
    const err = new EventStoreError('msg', root);
    expect(err.cause).toBe(root);
  });

  it('cause can be any value', () => {
    const err = new EventStoreError('msg', { code: 42 });
    expect(err.cause).toEqual({ code: 42 });
  });

  it('stores the message', () => {
    const err = new EventStoreError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('has a stack trace', () => {
    const err = new EventStoreError('msg');
    expect(err.stack).toBeDefined();
  });
});
