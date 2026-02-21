import { describe, it, expect, vi } from 'vitest';
import {
  DDL_CREATE_TABLE,
  DDL_CREATE_GIN_INDEX,
  DDL_TUNE_GIN_INDEX,
  DDL_CREATE_TYPE_POSITION_INDEX,
  DDL_CREATE_BRIN_INDEX,
  DDL_TUNE_AUTOVACUUM,
  applySchema,
} from '../../src/store/schema.js';

// Combine all DDL for full-text searches
const ALL_DDL = [
  DDL_CREATE_TABLE,
  DDL_CREATE_GIN_INDEX,
  DDL_TUNE_GIN_INDEX,
  DDL_CREATE_TYPE_POSITION_INDEX,
  DDL_CREATE_BRIN_INDEX,
  DDL_TUNE_AUTOVACUUM,
].join('\n');

describe('DDL_CREATE_TABLE', () => {
  it('contains CREATE TABLE IF NOT EXISTS events', () => {
    expect(DDL_CREATE_TABLE).toContain('CREATE TABLE IF NOT EXISTS events');
  });

  it('defines global_position as BIGSERIAL PRIMARY KEY', () => {
    expect(DDL_CREATE_TABLE).toMatch(/global_position\s+BIGSERIAL\s+PRIMARY KEY/i);
  });

  it('defines event_id as UUID with gen_random_uuid() default and UNIQUE', () => {
    expect(DDL_CREATE_TABLE).toContain('gen_random_uuid()');
    expect(DDL_CREATE_TABLE).toContain('UNIQUE');
  });

  it('defines type as VARCHAR(255) NOT NULL', () => {
    expect(DDL_CREATE_TABLE).toMatch(/type\s+VARCHAR\(255\)\s+NOT NULL/i);
  });

  it('defines payload as JSONB NOT NULL', () => {
    expect(DDL_CREATE_TABLE).toMatch(/payload\s+JSONB\s+NOT NULL/i);
  });

  it('defines metadata as JSONB (nullable — no NOT NULL)', () => {
    expect(DDL_CREATE_TABLE).toMatch(/metadata\s+JSONB/i);
    // metadata line should NOT have NOT NULL
    const metadataLine = DDL_CREATE_TABLE
      .split('\n')
      .find(l => /metadata\s+JSONB/i.test(l));
    expect(metadataLine).toBeDefined();
    expect(metadataLine).not.toMatch(/NOT NULL/i);
  });

  it('defines occurred_at as TIMESTAMPTZ NOT NULL DEFAULT NOW()', () => {
    expect(DDL_CREATE_TABLE).toMatch(/occurred_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/i);
  });
});

describe('DDL_CREATE_GIN_INDEX', () => {
  it('creates idx_events_payload_gin', () => {
    expect(DDL_CREATE_GIN_INDEX).toContain('idx_events_payload_gin');
  });

  it('uses GIN index type', () => {
    expect(DDL_CREATE_GIN_INDEX).toMatch(/USING GIN/i);
  });

  it('uses jsonb_path_ops operator class', () => {
    expect(DDL_CREATE_GIN_INDEX).toContain('jsonb_path_ops');
  });

  it('uses IF NOT EXISTS', () => {
    expect(DDL_CREATE_GIN_INDEX).toContain('IF NOT EXISTS');
  });
});

describe('DDL_TUNE_GIN_INDEX', () => {
  it('sets gin_pending_list_limit to 65536', () => {
    expect(DDL_TUNE_GIN_INDEX).toContain('gin_pending_list_limit = 65536');
  });

  it('enables fastupdate', () => {
    expect(DDL_TUNE_GIN_INDEX).toMatch(/fastupdate\s*=\s*on/i);
  });
});

describe('DDL_CREATE_TYPE_POSITION_INDEX', () => {
  it('creates idx_events_type_position', () => {
    expect(DDL_CREATE_TYPE_POSITION_INDEX).toContain('idx_events_type_position');
  });

  it('covers (type, global_position)', () => {
    expect(DDL_CREATE_TYPE_POSITION_INDEX).toMatch(/\(\s*type\s*,\s*global_position\s*\)/i);
  });

  it('uses IF NOT EXISTS', () => {
    expect(DDL_CREATE_TYPE_POSITION_INDEX).toContain('IF NOT EXISTS');
  });
});

describe('DDL_CREATE_BRIN_INDEX', () => {
  it('creates idx_events_occurred_at_brin', () => {
    expect(DDL_CREATE_BRIN_INDEX).toContain('idx_events_occurred_at_brin');
  });

  it('uses BRIN index type', () => {
    expect(DDL_CREATE_BRIN_INDEX).toMatch(/USING BRIN/i);
  });

  it('covers occurred_at', () => {
    expect(DDL_CREATE_BRIN_INDEX).toContain('occurred_at');
  });
});

describe('DDL_TUNE_AUTOVACUUM', () => {
  it('sets autovacuum_vacuum_scale_factor to 0.01', () => {
    expect(DDL_TUNE_AUTOVACUUM).toContain('autovacuum_vacuum_scale_factor');
    expect(DDL_TUNE_AUTOVACUUM).toContain('0.01');
  });

  it('sets autovacuum_analyze_scale_factor', () => {
    expect(DDL_TUNE_AUTOVACUUM).toContain('autovacuum_analyze_scale_factor');
  });

  it('sets autovacuum_vacuum_cost_delay', () => {
    expect(DDL_TUNE_AUTOVACUUM).toContain('autovacuum_vacuum_cost_delay');
  });
});

describe('idx_events_type absence', () => {
  it('does NOT create idx_events_type (redundant — covered by type_position)', () => {
    // idx_events_type_position is fine; the standalone idx_events_type must not exist
    const withoutTypePosition = ALL_DDL.replace(/idx_events_type_position/g, '');
    expect(withoutTypePosition).not.toContain('idx_events_type');
  });
});

describe('applySchema()', () => {
  it('calls client.query exactly 6 times', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const mockClient = { query: mockQuery } as unknown as Parameters<typeof applySchema>[0];
    await applySchema(mockClient);
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it('executes DDL statements in the correct order', async () => {
    const calls: string[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation((sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    } as unknown as Parameters<typeof applySchema>[0];
    await applySchema(mockClient);
    expect(calls[0]).toBe(DDL_CREATE_TABLE);
    expect(calls[1]).toBe(DDL_CREATE_GIN_INDEX);
    expect(calls[2]).toBe(DDL_TUNE_GIN_INDEX);
    expect(calls[3]).toBe(DDL_CREATE_TYPE_POSITION_INDEX);
    expect(calls[4]).toBe(DDL_CREATE_BRIN_INDEX);
    expect(calls[5]).toBe(DDL_TUNE_AUTOVACUUM);
  });
});
