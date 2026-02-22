import pg from 'pg';
import { applyProjectionSchema } from '../../src/projections/schema.js';

/**
 * Truncates projection_checkpoints and re-applies projection schema.
 * Call AFTER resetDatabase() in beforeEach.
 */
export async function resetProjectionSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Drop projection_checkpoints if it exists (it gets recreated by applyProjectionSchema)
    await client.query(`DROP TABLE IF EXISTS projection_checkpoints`);
    await applyProjectionSchema(client);
  } finally {
    client.release();
  }
}

/**
 * Polls projection_checkpoints every 50ms until last_position >= targetPosition,
 * or throws if timeoutMs elapses.
 */
export async function waitForProjectionPosition(
  pool: pg.Pool,
  projectionName: string,
  targetPosition: bigint,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ last_position: string | null }>(
      `SELECT last_position FROM projection_checkpoints WHERE name = $1`,
      [projectionName],
    );
    const pos = result.rows[0]?.last_position != null
      ? BigInt(result.rows[0].last_position)
      : 0n;
    if (pos >= targetPosition) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `waitForProjectionPosition timed out after ${timeoutMs}ms: "${projectionName}" did not reach ${targetPosition}`,
  );
}
