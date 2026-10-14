import { describe, it, expect } from 'vitest';
import { evaluateProjectionReadiness, cursorReached } from '../../src/projections/readiness.js';
import { STREAM_CURSOR_ORIGIN } from '../../src/types.js';

describe('evaluateProjectionReadiness (P1 #4)', () => {
  it('is pending until all expected loops have registered', () => {
    expect(
      evaluateProjectionReadiness([{ name: 'a', status: 'live' }], 2),
    ).toEqual({ kind: 'pending' });
  });

  it('is live only when every projection is live', () => {
    expect(
      evaluateProjectionReadiness(
        [
          { name: 'a', status: 'live' },
          { name: 'b', status: 'live' },
        ],
        2,
      ),
    ).toEqual({ kind: 'live' });
  });

  it('treats error as failure, not success', () => {
    const result = evaluateProjectionReadiness(
      [
        { name: 'ok', status: 'live' },
        { name: 'bad', status: 'error' },
      ],
      2,
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failed).toEqual([{ name: 'bad', status: 'error' }]);
    }
  });

  it('treats stopped as failure, not success', () => {
    const result = evaluateProjectionReadiness([{ name: 'gone', status: 'stopped' }], 1);
    expect(result.kind).toBe('failed');
  });
});

describe('cursorReached (P1 #4 waitForCursor)', () => {
  it('does not treat a higher global_position from an earlier tx as past a later cursor', () => {
    const current = { txId: '10', globalPosition: 99n };
    const target = { txId: '20', globalPosition: 1n };
    expect(cursorReached(current, target)).toBe(false);
  });

  it('reaches when tx_id and position are at or past the target', () => {
    expect(cursorReached({ txId: '20', globalPosition: 1n }, { txId: '20', globalPosition: 1n })).toBe(
      true,
    );
    expect(cursorReached({ txId: '21', globalPosition: 0n }, { txId: '20', globalPosition: 5n })).toBe(
      true,
    );
  });

  it('origin has not reached a real cursor', () => {
    expect(cursorReached(STREAM_CURSOR_ORIGIN, { txId: '1', globalPosition: 1n })).toBe(false);
  });
});
