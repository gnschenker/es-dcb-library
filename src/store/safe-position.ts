import type pg from 'pg';

/**
 * Computes the safe position for reading events in sequence.
 * 
 * BIGSERIAL assigns global_position before COMMIT, so a transaction with position N
 * might commit after a transaction with position N+1. To avoid permanently skipping
 * events, readers (projections, stream-after-position) must only advance up to a
 * position that is "safe" — meaning no earlier transaction can still commit below it.
 * 
 * Algorithm:
 * 1. Get the current transaction snapshot horizon (xmin) — this is the oldest
 *    transaction that is still in progress or might still be in progress.
 * 2. Find the maximum global_position where all rows have xmin < snapshot_xmin.
 * 3. This position is safe: all earlier positions are committed and visible.
 * 
 * Rationale:
 * - PostgreSQL's xmin system column records the transaction ID that inserted each row.
 * - txid_snapshot_xmin(txid_current_snapshot()) gives the oldest transaction ID that
 *   might still be running or uncommitted.
 * - A row with xmin < snapshot_xmin is guaranteed to be committed.
 * - The "safe position" is the highest global_position where all positions ≤ it
 *   have xmin < snapshot_xmin, ensuring no gaps from out-of-order commits.
 * 
 * Performance:
 * - This query uses the primary key index (global_position) and is fast.
 * - In high-throughput scenarios, the safe position lags slightly behind the actual
 *   max position, but this is acceptable for projection catch-up.
 * 
 * @param client - PostgreSQL client (can be a pool connection or transaction client)
 * @returns The safe global position, or 0n if no events exist
 */
export async function computeSafePosition(client: pg.ClientBase): Promise<bigint> {
  const result = await client.query<{ safe_pos: string | null }>(`
    SELECT COALESCE(
      (
        SELECT MAX(global_position)
        FROM events
        WHERE xmin::text::bigint < txid_snapshot_xmin(txid_current_snapshot())
      ),
      0
    ) AS safe_pos
  `);
  
  const safePosStr = result.rows[0]?.safe_pos;
  return safePosStr ? BigInt(safePosStr) : 0n;
}

/**
 * Computes the safe position with a candidate maximum position.
 * Returns min(candidateMax, safePosition).
 * 
 * This is useful when you know an upper bound (e.g., from a previous load)
 * and want to ensure you don't read beyond both that bound AND the safe position.
 * 
 * @param client - PostgreSQL client
 * @param candidateMax - Upper bound position to constrain the result
 * @returns The safe position, capped at candidateMax
 */
export async function computeSafePositionWithMax(
  client: pg.ClientBase,
  candidateMax: bigint,
): Promise<bigint> {
  const safePos = await computeSafePosition(client);
  return safePos < candidateMax ? safePos : candidateMax;
}
