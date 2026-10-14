import { describe, it, expect, vi } from 'vitest';
import {
  isConsistentStreamCursor,
  STREAM_CURSOR_ORIGIN,
  InconsistentStreamCursorError,
  PostgresEventStore,
} from '../../src/index.js';

describe('isConsistentStreamCursor', () => {
  it('accepts cursors without readXmin', () => {
    expect(isConsistentStreamCursor(STREAM_CURSOR_ORIGIN)).toBe(true);
    expect(isConsistentStreamCursor({ txId: '50', globalPosition: 9n })).toBe(true);
  });

  it('accepts load()-shaped cursors where txId < readXmin', () => {
    expect(
      isConsistentStreamCursor({ txId: '10', globalPosition: 4n, readXmin: '20' }),
    ).toBe(true);
    expect(
      isConsistentStreamCursor({ ...STREAM_CURSOR_ORIGIN, readXmin: '3' }),
    ).toBe(true);
  });

  it('rejects a later txId stitched onto an older readXmin', () => {
    expect(
      isConsistentStreamCursor({ txId: '80', globalPosition: 2n, readXmin: '5' }),
    ).toBe(false);
    expect(
      isConsistentStreamCursor({ txId: '5', globalPosition: 1n, readXmin: '5' }),
    ).toBe(false);
  });
});

describe('append rejects inconsistent after cursors', () => {
  it('throws InconsistentStreamCursorError before opening a transaction', async () => {
    const connect = vi.fn();
    const store = new PostgresEventStore({
      pool: { connect } as never,
    });

    await expect(
      store.append(
        { type: 'E', data: {}, tags: ['t'] },
        {
          failIfEventsMatch: { items: [{ tags: ['t'] }] },
          after: { txId: '80', globalPosition: 2n, readXmin: '5' },
        },
      ),
    ).rejects.toBeInstanceOf(InconsistentStreamCursorError);

    expect(connect).not.toHaveBeenCalled();
  });
});
