import type { StoredEvent } from 'es-dcb-library';
import { tagExtractors } from '../../src/store.js';

let pos = 1n;

export function resetEventPositions(): void {
  pos = 1n;
}

/** Stored event for unit tests with tags matching production tag extractors. */
export function makeEvent(type: string, data: Record<string, unknown>): StoredEvent {
  const extractor = tagExtractors[type];
  const tags = extractor ? extractor({ type, data }) : [];
  const globalPosition = pos++;
  return {
    globalPosition,
    eventId: `evt-${String(globalPosition)}`,
    type,
    data,
    metadata: null,
    occurredAt: new Date(),
    tags,
    txId: String(globalPosition),
  };
}
