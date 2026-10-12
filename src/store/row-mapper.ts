import type { StoredEvent } from '../types.js';

export interface EventRow {
  global_position: string; // pg returns BIGSERIAL as string by default
  event_id: string;
  type: string;
  data: Record<string, unknown>;        // pg auto-parses JSONB
  metadata: Record<string, unknown> | null;
  occurred_at: Date;                    // pg auto-parses TIMESTAMPTZ
  tags: string[];                       // pg auto-parses TEXT[] arrays
  tx_id: string;
}

export function mapRow(row: EventRow): StoredEvent {
  return {
    globalPosition: BigInt(row.global_position),
    eventId: row.event_id,
    type: row.type,
    data: row.data,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    tags: row.tags,
    txId: row.tx_id,
  };
}
