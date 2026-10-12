import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  TeacherNotFoundError,
  TeacherDismissedError,
  TeacherAssignedToOpenCourseError,
} from '../../domain/errors.js';
import type {
  TeacherDismissedPayload,
  TeacherRemovedFromCoursePayload,
} from '../../domain/events.js';

// Private to this slice
function teacherStream(teacherId: string) {
  return query([
    { types: ['TeacherHired'], tags: [`teacher:${teacherId}`] },
    { types: ['TeacherDismissed'], tags: [`teacher:${teacherId}`] },
  ]);
}

function courseStream(courseId: string) {
  return query([
    { types: ['CourseCreated'], tags: [`course:${courseId}`] },
    { types: ['CoursePublished'], tags: [`course:${courseId}`] },
    { types: ['CourseClosed'], tags: [`course:${courseId}`] },
    { types: ['CourseCancelled'], tags: [`course:${courseId}`] },
    { types: ['TeacherAssignedToCourse'], tags: [`course:${courseId}`] },
    { types: ['TeacherRemovedFromCourse'], tags: [`course:${courseId}`] },
  ]);
}

// Exported reducers (for unit tests)
export type TeacherDismissState = {
  status: 'none' | 'hired' | 'dismissed';
  name?: string;
  email?: string;
  department?: string;
};

export function reduceTeacher(events: StoredEvent[]): TeacherDismissState {
  let state: TeacherDismissState = { status: 'none' };
  for (const event of events) {
    const p = event.data;
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

export type CourseStateForDismiss = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  teacherId?: string | null;
};

export function reduceCourseForDismiss(events: StoredEvent[]): CourseStateForDismiss {
  let state: CourseStateForDismiss = { status: 'none' };
  for (const event of events) {
    const p = event.data;
    if (event.type === 'CourseCreated') {
      state = { status: 'draft', teacherId: null };
    } else if (event.type === 'TeacherAssignedToCourse') {
      state = { ...state, teacherId: p['teacherId'] as string };
    } else if (event.type === 'TeacherRemovedFromCourse') {
      state = { ...state, teacherId: null };
    } else if (event.type === 'CoursePublished') {
      state = { ...state, status: 'open' };
    } else if (event.type === 'CourseClosed') {
      state = { ...state, status: 'closed' };
    } else if (event.type === 'CourseCancelled') {
      state = { ...state, status: 'cancelled' };
    }
  }
  return state;
}

export interface DismissTeacherInput {
  teacherId: string;
  reason: string;
}

export async function dismissTeacher(
  store: EventStore,
  clock: Clock,
  input: DismissTeacherInput,
): Promise<void> {
  const { events, version } = await store.load(teacherStream(input.teacherId));
  const state = reduceTeacher(events);

  if (state.status === 'none') {
    throw new TeacherNotFoundError(`Teacher '${input.teacherId}' not found`);
  }
  if (state.status === 'dismissed') {
    throw new TeacherDismissedError(`Teacher '${input.teacherId}' is already dismissed`);
  }

  // Scan courses assigned to this teacher (best-effort — see university-app-plan.md §9 for known race condition)
  // A concurrent AssignTeacherToCourse between this scan and the final append could slip through.
  const assignedCourseIds = new Set<string>();
  for await (const event of store.stream(
    queryItem({ types: ['TeacherAssignedToCourse'], tags: [`teacher:${input.teacherId}`] }),
  )) {
    assignedCourseIds.add(event.data['courseId'] as string);
  }

  const removedEvents: NewEvent[] = [];
  for (const courseId of assignedCourseIds) {
    const { events: courseEvents } = await store.load(courseStream(courseId));
    const courseState = reduceCourseForDismiss(courseEvents);

    if (courseState.teacherId !== input.teacherId) continue; // already reassigned

    if (courseState.status === 'open') {
      throw new TeacherAssignedToOpenCourseError(
        `Cannot dismiss teacher '${input.teacherId}': assigned to open course '${courseId}'`,
      );
    }

    if (courseState.status === 'draft') {
      const removedPayload: TeacherRemovedFromCoursePayload = {
        courseId,
        teacherId: input.teacherId,
        removedAt: clock.now().toISOString(),
      };
      removedEvents.push({ type: 'TeacherRemovedFromCourse', data: removedPayload as unknown as Record<string, unknown>, tags: [] } as NewEvent);
    }
  }

  const dismissedPayload: TeacherDismissedPayload = {
    teacherId: input.teacherId,
    reason: input.reason,
    dismissedAt: clock.now().toISOString(),
  };

  await store.append(
    [...removedEvents, { type: 'TeacherDismissed', data: dismissedPayload as unknown as Record<string, unknown>, tags: [] } as NewEvent],
    { failIfEventsMatch: teacherStream(input.teacherId), after: version },
  );
}
