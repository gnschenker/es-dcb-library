import type { NewEvent } from '../types.js';
import type { AppendCondition } from '../types.js';
import { extractConditionLockKeys } from '../query/compiler.js';

const MAX_EVENT_TYPES = 20;

export function buildAppendSpanAttributes(
  eventList: NewEvent[],
  condition: AppendCondition | undefined,
  tagCountTotal: number,
): Record<string, string | number | boolean | string[]> {
  const types = [...new Set(eventList.map((e) => e.type))].slice(0, MAX_EVENT_TYPES);
  const attrs: Record<string, string | number | boolean | string[]> = {
    'db.system': 'postgresql',
    'db.operation': 'append',
    'dcb.event.count': eventList.length,
    'dcb.event.types': types,
    'dcb.tags.count': tagCountTotal,
    'dcb.append.has_condition': condition !== undefined,
  };
  if (condition !== undefined) {
    attrs['dcb.lock.pair_count'] = extractConditionLockKeys(condition.failIfEventsMatch).length;
  }
  return attrs;
}

export function buildLockSpanAttributes(pairCount: number): Record<string, string | number | boolean> {
  return {
    'dcb.lock.pair_count': pairCount,
    'dcb.lock.blocking': true,
  };
}
