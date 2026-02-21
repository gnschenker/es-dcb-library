import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import {
  CourseNotFoundError,
  CourseAlreadyCancelledError,
} from '../domain/errors.js';
import type {
  CourseCancelledPayload,
  StudentDroppedPayload,
  StudentWithdrewPayload,
} from '../domain/events.js';

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
export type CourseCancelState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  dropDeadline?: string;
  withdrawalDeadline?: string;
};

export function reduceCourseForCancel(events: StoredEvent[]): CourseCancelState {
  let state: CourseCancelState = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        dropDeadline: p['dropDeadline'] as string,
        withdrawalDeadline: p['withdrawalDeadline'] as string,
      };
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

export type EnrollmentCancelState = {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
};

export function reduceEnrollmentForCancel(events: StoredEvent[]): EnrollmentCancelState {
  let status: EnrollmentCancelState['status'] = 'none';
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

export interface CancelCourseInput {
  courseId: string;
  reason: string;
}

export async function cancelCourse(
  store: EventStore,
  clock: Clock,
  input: CancelCourseInput,
): Promise<void> {
  const [
    { events: courseEvents, version: courseVersion },
    { events: courseEnrollEvents, version: enrollmentVersion },
  ] = await Promise.all([
    store.load(courseStream(input.courseId)),
    store.load(courseEnrollmentStream(input.courseId)),
  ]);

  const courseState = reduceCourseForCancel(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status === 'cancelled') {
    throw new CourseAlreadyCancelledError(`Course '${input.courseId}' is already cancelled`);
  }

  // Collect unique student IDs from course enrollment stream
  const studentIds = new Set<string>();
  for (const event of courseEnrollEvents) {
    if (event.type === 'StudentEnrolled') {
      studentIds.add(event.payload['studentId'] as string);
    }
  }

  const now = clock.now();
  const unenrollEvents: NewEvent[] = [];

  for (const studentId of studentIds) {
    // Per-student load: courseEnrollmentStream lacks grading events; we need to check
    // if the student has already been graded (graded students skip automated unenrollment per BR-E9)
    const { events: perStudentEvents } = await store.load(
      enrollmentStream(studentId, input.courseId),
    );
    const enrollmentState = reduceEnrollmentForCancel(perStudentEvents);

    // Only unenroll students who are still actively enrolled (not graded/passed/failed/dropped/withdrew)
    if (enrollmentState.status !== 'enrolled') continue;

    if (courseState.dropDeadline && now <= new Date(courseState.dropDeadline)) {
      const payload: StudentDroppedPayload = {
        studentId,
        courseId: input.courseId,
        droppedAt: now.toISOString(),
        droppedBy: 'system',
      };
      unenrollEvents.push({ type: 'StudentDropped', payload: payload as unknown as Record<string, unknown> } as NewEvent);
    } else {
      const payload: StudentWithdrewPayload = {
        studentId,
        courseId: input.courseId,
        withdrewAt: now.toISOString(),
        withdrewBy: 'system',
      };
      unenrollEvents.push({ type: 'StudentWithdrew', payload: payload as unknown as Record<string, unknown> } as NewEvent);
    }
  }

  const cancelPayload: CourseCancelledPayload = {
    courseId: input.courseId,
    reason: input.reason,
    cancelledAt: now.toISOString(),
  };

  await store.append(
    [...unenrollEvents, { type: 'CourseCancelled', payload: cancelPayload as unknown as Record<string, unknown> } as NewEvent],
    {
      query: courseStream(input.courseId),
      concurrencyQuery: courseEnrollmentStream(input.courseId),
      expectedVersion: enrollmentVersion,
    },
  );
}
