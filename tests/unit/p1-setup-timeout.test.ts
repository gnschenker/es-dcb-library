import { describe, it, expect, vi } from 'vitest';
import { runProjectionSetup } from '../../src/projections/setup.js';
import { ProjectionSetupTimeoutError } from '../../src/errors.js';
import { defineProjection } from '../../src/projections/types.js';
import { queryItem } from '../../src/index.js';

describe('runProjectionSetup (P1 #5)', () => {
  it('sets statement_timeout and does not release until setup settles after cancel', async () => {
    const order: string[] = [];
    let resolveSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });

    const setupClient = {
      processID: 4242,
      query: vi.fn(async (sql: string) => {
        order.push(`query:${sql.slice(0, 24)}`);
        return { rows: [] };
      }),
      release: vi.fn(() => {
        order.push('release');
      }),
    };

    const pool = {
      connect: vi.fn(async () => setupClient),
      query: vi.fn(async (sql: string) => {
        order.push(`pool:${sql.slice(0, 28)}`);
        return { rows: [] };
      }),
    };

    const def = defineProjection({
      name: 'slow-setup',
      query: queryItem({ types: ['E'] }),
      setup: async () => {
        resolveSetup();
        await new Promise((r) => setTimeout(r, 80));
        order.push('setup-finished');
      },
      handler: async () => {},
    });

    const run = runProjectionSetup(def, pool as never, 20);
    await setupStarted;
    await expect(run).rejects.toBeInstanceOf(ProjectionSetupTimeoutError);
    expect(order).toContain('setup-finished');
    expect(order.indexOf('release')).toBeGreaterThan(order.indexOf('setup-finished'));
    expect(pool.query).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [4242]);
    expect(setupClient.query.mock.calls.some(([sql]) => String(sql).includes('statement_timeout'))).toBe(
      true,
    );
  });
});
