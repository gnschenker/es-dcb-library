import { describe, it, expect } from 'vitest';
import { ConcurrencyError, EventStoreError, EmptyBatchError } from '../../src/errors.js';
import { STREAM_CURSOR_ORIGIN } from '../../src/types.js';

const cursor = (gp: bigint, txId = '1') => ({ txId, globalPosition: gp });

describe('ConcurrencyError', () => {
  it('constructs without error', () => {
    expect(() => new ConcurrencyError(cursor(1n), cursor(2n))).not.toThrow();
  });

  it('has correct name', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err.name).toBe('ConcurrencyError');
  });

  it('stores expectedPosition', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err.expectedPosition).toEqual(cursor(1n));
  });

  it('stores actualPosition', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err.actualPosition).toEqual(cursor(2n));
  });

  it('is instanceof ConcurrencyError', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err).toBeInstanceOf(ConcurrencyError);
  });

  it('is instanceof Error', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err).toBeInstanceOf(Error);
  });

  it('generates a default message when none provided', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err.message).toBeTruthy();
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('uses custom message when provided', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n), 'my message');
    expect(err.message).toBe('my message');
  });

  it('has a stack trace', () => {
    const err = new ConcurrencyError(cursor(1n), cursor(2n));
    expect(err.stack).toBeDefined();
  });

  it('works with STREAM_CURSOR_ORIGIN', () => {
    const err = new ConcurrencyError(STREAM_CURSOR_ORIGIN, STREAM_CURSOR_ORIGIN);
    expect(err.expectedPosition).toEqual(STREAM_CURSOR_ORIGIN);
    expect(err.actualPosition).toEqual(STREAM_CURSOR_ORIGIN);
  });

  it('works with very large bigint positions', () => {
    const big = 9007199254740993n;
    const err = new ConcurrencyError(cursor(big), cursor(big + 1n));
    expect(err.expectedPosition.globalPosition).toBe(big);
    expect(err.actualPosition.globalPosition).toBe(big + 1n);
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

describe('EmptyBatchError', () => {
  it('has correct name and default message', () => {
    const err = new EmptyBatchError();
    expect(err).toBeInstanceOf(EmptyBatchError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmptyBatchError');
    expect(err.message).toBe('Cannot append an empty batch');
  });

  it('uses a custom message when provided', () => {
    const err = new EmptyBatchError('no events');
    expect(err.message).toBe('no events');
  });
});
