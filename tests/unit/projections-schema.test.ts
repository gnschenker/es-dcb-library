import { describe, it, expect } from 'vitest';
import {
  DDL_CREATE_CHECKPOINTS_TABLE,
  DDL_CREATE_NOTIFY_FUNCTION,
  DDL_CREATE_NOTIFY_TRIGGER,
} from '../../src/projections/schema.js';

describe('DDL_CREATE_CHECKPOINTS_TABLE', () => {
  it('contains IF NOT EXISTS', () => {
    expect(DDL_CREATE_CHECKPOINTS_TABLE).toContain('IF NOT EXISTS');
  });

  it('has PRIMARY KEY on name column', () => {
    expect(DDL_CREATE_CHECKPOINTS_TABLE).toContain('PRIMARY KEY');
    expect(DDL_CREATE_CHECKPOINTS_TABLE).toContain('name');
  });

  it('declares last_position as BIGINT NULL (not NOT NULL or DEFAULT 0)', () => {
    expect(DDL_CREATE_CHECKPOINTS_TABLE).toMatch(/last_position\s+BIGINT\s+NULL/);
    expect(DDL_CREATE_CHECKPOINTS_TABLE).not.toMatch(/last_position\s+BIGINT\s+NOT NULL/);
    expect(DDL_CREATE_CHECKPOINTS_TABLE).not.toContain('DEFAULT 0');
  });
});

describe('DDL_CREATE_NOTIFY_FUNCTION', () => {
  it('contains CREATE OR REPLACE FUNCTION', () => {
    expect(DDL_CREATE_NOTIFY_FUNCTION).toContain('CREATE OR REPLACE FUNCTION');
  });

  it('uses the es_events channel', () => {
    expect(DDL_CREATE_NOTIFY_FUNCTION).toContain("'es_events'");
  });

  it('returns NULL (required for statement-level triggers)', () => {
    expect(DDL_CREATE_NOTIFY_FUNCTION).toContain('RETURN NULL');
  });
});

describe('DDL_CREATE_NOTIFY_TRIGGER', () => {
  it('contains CREATE OR REPLACE TRIGGER', () => {
    expect(DDL_CREATE_NOTIFY_TRIGGER).toContain('CREATE OR REPLACE TRIGGER');
  });

  it('references trg_es_events_notify', () => {
    expect(DDL_CREATE_NOTIFY_TRIGGER).toContain('trg_es_events_notify');
  });

  it('uses FOR EACH STATEMENT (not FOR EACH ROW)', () => {
    expect(DDL_CREATE_NOTIFY_TRIGGER).toContain('FOR EACH STATEMENT');
    expect(DDL_CREATE_NOTIFY_TRIGGER).not.toContain('FOR EACH ROW');
  });
});
