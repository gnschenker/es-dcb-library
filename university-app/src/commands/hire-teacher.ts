import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import { teacherIdFromEmail } from '../domain/ids.js';
import { TeacherAlreadyHiredError } from '../domain/errors.js';
import type { TeacherHiredPayload } from '../domain/events.js';

// Private to this slice
function teacherStream(teacherId: string) {
  return query
    .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
    .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
}

// Exported reducer (for unit tests — not imported by other slices)
export type TeacherHireState = {
  status: 'none' | 'hired' | 'dismissed';
  name?: string;
  email?: string;
  department?: string;
};

export function reduceTeacher(events: StoredEvent[]): TeacherHireState {
  let state: TeacherHireState = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'TeacherHired') {
      state = {
        status: 'hired',
        name: p['name'] as string,
        email: p['email'] as string,
        department: p['department'] as string,
      };
    } else if (event.type === 'TeacherDismissed') {
      state = { ...state, status: 'dismissed' };
    }
  }
  return state;
}

export interface HireTeacherInput {
  name: string;
  email: string;
  department: string;
}

export async function hireTeacher(
  store: EventStore,
  clock: Clock,
  input: HireTeacherInput,
): Promise<{ teacherId: string }> {
  const teacherId = teacherIdFromEmail(input.email);
  const { events, version } = await store.load(teacherStream(teacherId));
  const state = reduceTeacher(events);

  if (state.status === 'hired') {
    throw new TeacherAlreadyHiredError(
      `Teacher with email '${input.email}' is already hired`,
    );
  }

  const payload: TeacherHiredPayload = {
    teacherId,
    name: input.name,
    email: input.email,
    department: input.department,
    hiredAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'TeacherHired', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: teacherStream(teacherId), expectedVersion: version },
  );

  return { teacherId };
}
