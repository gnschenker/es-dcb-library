import type pg from 'pg';

/**
 * Computes the safe position for reading events in global_position order.
 *
 * BIGSERIAL assigns global_position when the row is inserted, but writers can
 * commit out of order. A follower must not advance past a position while any
 * lower global_position row might still come from an in-flight transaction.
 *
 * Each event stores `tx_id` (DEFAULT pg_current_xact_id()) at insert time.
 * The horizon is pg_snapshot_xmin(pg_current_snapshot()): transactions with
 * tx_id >= horizon may still be active. Safe position is the largest
 * global_position such that every row with a lower position has tx_id < horizon.
 *
 * Equivalent SQL (single snapshot read, no per-row xmin cast):
 *   safe = MIN(global_position) among rows with tx_id >= horizon, minus 1;
 *   if no such rows, safe = MAX(global_position).
 *
 * Performance: one index-friendly lookup on uncommitted tx_id (idx_events_tx_id_position),
 * not a full-table scan casting xmin.
 */
export async function computeSafePosition(client: pg.ClientBase): Promise<bigint> {
  const result = await client.query<{ safe_pos: string }>(`
    WITH horizon AS (
      SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin
    )
    SELECT COALESCE(
      (
        SELECT MIN(e.global_position) - 1
        FROM events e, horizon h
        WHERE e.tx_id >= h.xmin
      ),
      (SELECT MAX(global_position) FROM events),
      0
    )::text AS safe_pos
  `);

  return BigInt(result.rows[0]!.safe_pos);
}

export async function computeSafePositionWithMax(
  client: pg.ClientBase,
  candidateMax: bigint,
): Promise<bigint> {
  const safePos = await computeSafePosition(client);
  return safePos < candidateMax ? safePos : candidateMax;
}
