import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNotInDraftError,
  CourseNoTeacherError,
  TeacherDismissedError,
} from '../../domain/errors.js';
import type { CoursePublishedPayload } from '../../domain/events.js';

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

function teacherStream(teacherId: string) {
  return query
    .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
    .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
}

// Exported reducers (for unit tests)
export type CoursePublishState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  teacherId?: string | null;
  maxStudents?: number;
  creditHours?: number;
  prerequisites?: string[];
  passingGrade?: number;
};

export function reduceCourseForPublish(events: StoredEvent[]): CoursePublishState {
  let state: CoursePublishState = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        teacherId: null,
        maxStudents: p['maxStudents'] as number,
        creditHours: p['creditHours'] as number,
        prerequisites: p['prerequisites'] as string[],
        passingGrade: p['passingGrade'] as number,
      };
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

export type TeacherPublishState = { status: 'none' | 'hired' | 'dismissed' };

export function reduceTeacherForPublish(events: StoredEvent[]): TeacherPublishState {
  let status: 'none' | 'hired' | 'dismissed' = 'none';
  for (const event of events) {
    if (event.type === 'TeacherHired') status = 'hired';
    else if (event.type === 'TeacherDismissed') status = 'dismissed';
  }
  return { status };
}

export interface PublishCourseInput { courseId: string; }

export async function publishCourse(
  store: EventStore,
  clock: Clock,
  input: PublishCourseInput,
): Promise<void> {
  const { events: courseEvents, version: courseVersion } = await store.load(courseStream(input.courseId));
  const courseState = reduceCourseForPublish(courseEvents);

  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status !== 'draft') {
    throw new CourseNotInDraftError(
      `Course '${input.courseId}' is not in draft status (current: ${courseState.status})`,
    );
  }
  if (courseState.teacherId == null) {
    throw new CourseNoTeacherError(`Course '${input.courseId}' has no teacher assigned`);
  }

  const { events: teacherEvents } = await store.load(teacherStream(courseState.teacherId));
  const teacherState = reduceTeacherForPublish(teacherEvents);
  if (teacherState.status !== 'hired') {
    throw new TeacherDismissedError(
      `Assigned teacher '${courseState.teacherId}' is not actively hired`,
    );
  }

  // Note: dropDeadline and withdrawalDeadline are intentionally absent from CoursePublishedPayload
  // They are set once in CourseCreated and must be read from the full course stream by downstream consumers.
  const payload: CoursePublishedPayload = {
    courseId: input.courseId,
    teacherId: courseState.teacherId,
    maxStudents: courseState.maxStudents!,
    creditHours: courseState.creditHours!,
    prerequisites: courseState.prerequisites!,
    passingGrade: courseState.passingGrade!,
  };

  await store.append(
    [{ type: 'CoursePublished', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: courseStream(input.courseId), expectedVersion: courseVersion },
  );
}
