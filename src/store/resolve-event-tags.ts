import type { NewEvent, TagExtractor } from '../types.js';
import { UNTAGGED } from '../types.js';
import { MissingTagExtractorError, InvalidTagError } from '../errors.js';

export interface ResolvedAppendEvent {
  event: NewEvent;
  tags: string[];
}

export function resolveAppendEvents(
  eventList: NewEvent[],
  tagExtractors: Record<string, TagExtractor | typeof UNTAGGED>,
): ResolvedAppendEvent[] {
  return eventList.map((event) => ({
    event,
    tags: resolveFinalTags(event, tagExtractors),
  }));
}

export function resolveFinalTags(
  event: NewEvent,
  tagExtractors: Record<string, TagExtractor | typeof UNTAGGED>,
): string[] {
  const eventTags = event.tags ?? [];
  const extractorOrMarker = tagExtractors[event.type];

  let extractedTags: string[] = [];

  if (extractorOrMarker === UNTAGGED) {
    extractedTags = [];
  } else if (typeof extractorOrMarker === 'function') {
    extractedTags = extractorOrMarker(event);
  } else if (eventTags.length === 0) {
    throw new MissingTagExtractorError(
      event.type,
      `Event type '${event.type}' has no registered tag extractor and no explicit tags were provided. ` +
        `Either register a tag extractor, mark it as UNTAGGED, or pass tags explicitly in the event.`,
    );
  }

  const finalTags = [...new Set([...eventTags, ...extractedTags])];
  for (const tag of finalTags) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new InvalidTagError(tag);
    }
  }
  return finalTags;
}
