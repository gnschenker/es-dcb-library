import type { StoredEvent } from '../types.js';

export interface EventRow {
  global_position: string; // pg returns BIGSERIAL as string by default
  event_id: string;
  type: string;
  payload: Record<string, unknown>;   // pg auto-parses JSONB
  metadata: Record<string, unknown> | null;
  occurred_at: Date;                  // pg auto-parses TIMESTAMPTZ
}

export function mapRow(row: EventRow): StoredEvent {
  return {
    globalPosition: BigInt(row.global_position),
    eventId: row.event_id,
    type: row.type,
    payload: row.payload,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}
