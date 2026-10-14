import type { StreamCursor } from '../types.js';
import type { ProjectionStatus } from './loop.js';

export type ReadinessResult =
  | { kind: 'pending' }
  | { kind: 'live' }
  | { kind: 'failed'; failed: Array<{ name: string; status: ProjectionStatus }> };

/**
 * waitUntilLive succeeds only when every expected projection is `live`.
 * `error` and `stopped` are failures (not success).
 */
export function evaluateProjectionReadiness(
  states: Array<{ name: string; status: ProjectionStatus }>,
  expectedCount: number,
): ReadinessResult {
  if (expectedCount === 0 || states.length < expectedCount) {
    return { kind: 'pending' };
  }
  const failed = states.filter((s) => s.status === 'error' || s.status === 'stopped');
  if (failed.length > 0) {
    return { kind: 'failed', failed: failed.map((s) => ({ name: s.name, status: s.status })) };
  }
  if (states.every((s) => s.status === 'live')) {
    return { kind: 'live' };
  }
  return { kind: 'pending' };
}

/** True when `current` is at or past `target` in (tx_id, global_position) order. */
export function cursorReached(current: StreamCursor, target: StreamCursor): boolean {
  const currentTx = BigInt(current.txId);
  const targetTx = BigInt(target.txId);
  return (
    currentTx > targetTx ||
    (currentTx === targetTx && current.globalPosition >= target.globalPosition)
  );
}
