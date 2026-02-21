import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNoTeacherError,
  CourseHasActiveEnrollmentsError,
} from '../domain/errors.js';
import type { TeacherRemovedFromCoursePayload } from '../domain/events.js';

// Private to this slice
function courseStream(courseId: string) {
  return query
    .eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
    .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
    .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
    .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
}

function courseEnrollmentStream(courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('courseId').equals(courseId);
}

// Exported reducers (for unit tests)
export type CourseRemoveState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  teacherId?: string | null;
};

export function reduceCourseForRemove(events: StoredEvent[]): CourseRemoveState {
  let state: CourseRemoveState = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
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

export function reduceEnrollmentCountForRemove(events: StoredEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'StudentEnrolled') count++;
    else if (event.type === 'StudentDropped' || event.type === 'StudentWithdrew') {
      count = Math.max(0, count - 1);
    }
  }
  return count;
}

export interface RemoveTeacherInput { courseId: string; }

export async function removeTeacher(
  store: EventStore,
  clock: Clock,
  input: RemoveTeacherInput,
): Promise<void> {
  const [
    { events: courseEvents, version: courseVersion },
    { events: enrollEvents },
  ] = await Promise.all([
    store.load(courseStream(input.courseId)),
    store.load(courseEnrollmentStream(input.courseId)),
  ]);

  const courseState = reduceCourseForRemove(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.teacherId == null) {
    throw new CourseNoTeacherError(`Course '${input.courseId}' has no teacher assigned`);
  }
  if (courseState.status === 'open' && reduceEnrollmentCountForRemove(enrollEvents) > 0) {
    throw new CourseHasActiveEnrollmentsError(
      `Cannot remove teacher from open course '${input.courseId}' with active enrollments`,
    );
  }

  const payload: TeacherRemovedFromCoursePayload = {
    courseId: input.courseId,
    teacherId: courseState.teacherId,
    removedAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'TeacherRemovedFromCourse', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: courseStream(input.courseId), expectedVersion: courseVersion },
  );
}
