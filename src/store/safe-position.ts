import type pg from 'pg';

/**
 * Safe position for ordered followers (projections, stream-after-position).
 *
 * Each event stores `tx_id` (DEFAULT pg_current_xact_id()). A row is
 * durable for followers when `tx_id < pg_snapshot_xmin(pg_current_snapshot())`.
 *
 * Uncommitted rows are not visible to other backends, so we cannot scan
 * in-flight inserts directly. Instead: among committed positions, find the
 * first missing slot in [1 .. upper_bound] where upper_bound is the greater
 * of sequence last_value and max committed position. Safe = first_gap - 1
 * (or upper_bound if no gaps).
 *
 * This covers nextval-before-insert: an active transaction can hold a lower
 * position while a higher one is already committed.
 */
export async function computeSafePosition(client: pg.ClientBase): Promise<bigint> {
  const result = await client.query<{ safe_pos: string }>(`
    WITH horizon AS (
      SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin
    ),
    committed AS (
      SELECT e.global_position
      FROM events e, horizon h
      WHERE e.tx_id < h.xmin
    ),
    seq AS (
      SELECT last_value::bigint AS last_val
      FROM pg_sequences
      WHERE schemaname = 'public'
        AND sequencename = 'events_global_position_seq'
    ),
    upper AS (
      SELECT GREATEST(
        COALESCE((SELECT last_val FROM seq), 0),
        COALESCE((SELECT MAX(global_position) FROM committed), 0)
      ) AS hi
    ),
    first_gap AS (
      SELECT MIN(s.pos) AS pos
      FROM upper u
      CROSS JOIN LATERAL generate_series(1::bigint, u.hi) AS s(pos)
      WHERE NOT EXISTS (
        SELECT 1 FROM committed c WHERE c.global_position = s.pos
      )
    )
    SELECT COALESCE(
      (SELECT pos - 1 FROM first_gap),
      (SELECT hi FROM upper),
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
