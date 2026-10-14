import type pg from 'pg';
import { ProjectionSetupTimeoutError } from '../errors.js';
import type { ProjectionDefinition } from './types.js';
import { sleep } from './loop.js';

/**
 * Runs projection setup with a database statement_timeout and cancels the
 * backend if the JS timeout fires, waiting for setup to settle before release.
 */
export async function runProjectionSetup(
  def: ProjectionDefinition,
  pool: pg.Pool,
  timeoutMs: number,
): Promise<void> {
  if (def.setup === undefined) {
    return;
  }

  const setupClient = await pool.connect();
  const pid = (setupClient as pg.PoolClient & { processID?: number }).processID;
  let setupPromise: Promise<void> | undefined;

  try {
    await setupClient.query(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    setupPromise = def.setup(setupClient);

    let timedOut = false;
    const timeoutPromise = sleep(timeoutMs).then(() => {
      timedOut = true;
      throw new ProjectionSetupTimeoutError(def.name, timeoutMs);
    });

    await Promise.race([setupPromise, timeoutPromise]);
    if (timedOut) {
      throw new ProjectionSetupTimeoutError(def.name, timeoutMs);
    }
  } catch (err) {
    if (err instanceof ProjectionSetupTimeoutError) {
      if (typeof pid === 'number') {
        await pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
      }
      if (setupPromise !== undefined) {
        await setupPromise.catch(() => undefined);
      }
    }
    throw err;
  } finally {
    setupClient.release();
  }
}
