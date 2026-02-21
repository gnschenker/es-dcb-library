import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNotOpenError,
  CourseHasActiveEnrollmentsError,
} from '../domain/errors.js';
import type { CourseClosedPayload } from '../domain/events.js';

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

function enrollmentStream(studentId: string, courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
}

// Exported reducers (for unit tests)
export type CourseCloseState = { status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled' };

export function reduceCourseForClose(events: StoredEvent[]): CourseCloseState {
  let status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled' = 'none';
  for (const event of events) {
    if (event.type === 'CourseCreated') status = 'draft';
    else if (event.type === 'CoursePublished') status = 'open';
    else if (event.type === 'CourseClosed') status = 'closed';
    else if (event.type === 'CourseCancelled') status = 'cancelled';
  }
  return { status };
}

export type EnrollmentCloseState = { status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed' };

export function reduceEnrollmentForClose(events: StoredEvent[]): EnrollmentCloseState {
  let status: EnrollmentCloseState['status'] = 'none';
  for (const event of events) {
    if (event.type === 'StudentEnrolled') status = 'enrolled';
    else if (event.type === 'StudentDropped') status = 'dropped';
    else if (event.type === 'StudentWithdrew') status = 'withdrew';
    else if (event.type === 'StudentGraded') status = 'graded';
    else if (event.type === 'StudentPassedCourse') status = 'passed';
    else if (event.type === 'StudentFailedCourse') status = 'failed';
  }
  return { status };
}

export interface CloseCourseInput { courseId: string; }

export async function closeCourse(
  store: EventStore,
  clock: Clock,
  input: CloseCourseInput,
): Promise<void> {
  const [
    { events: courseEvents, version: courseVersion },
    { events: enrollEvents },
  ] = await Promise.all([
    store.load(courseStream(input.courseId)),
    store.load(courseEnrollmentStream(input.courseId)),
  ]);

  const courseState = reduceCourseForClose(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status !== 'open') {
    throw new CourseNotOpenError(
      `Course '${input.courseId}' is not open (current: ${courseState.status})`,
    );
  }

  // Collect unique student IDs from the enrollment stream
  const studentIds = new Set<string>();
  for (const event of enrollEvents) {
    if (event.type === 'StudentEnrolled') {
      studentIds.add(event.payload['studentId'] as string);
    }
  }

  // Per-student check: courseEnrollmentStream lacks grading events; load per-student enrollmentStream
  // to get correct terminal status (graded/passed/failed students should not block close)
  for (const studentId of studentIds) {
    const { events: perStudentEvents } = await store.load(enrollmentStream(studentId, input.courseId));
    const enrollmentState = reduceEnrollmentForClose(perStudentEvents);
    if (enrollmentState.status === 'enrolled') {
      throw new CourseHasActiveEnrollmentsError(
        `Course '${input.courseId}' has active enrollments and cannot be closed`,
      );
    }
  }

  const payload: CourseClosedPayload = {
    courseId: input.courseId,
    closedAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'CourseClosed', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: courseStream(input.courseId), expectedVersion: courseVersion },
  );
}
