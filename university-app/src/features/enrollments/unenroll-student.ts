import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem, combineQueries } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  StudentNotEnrolledError,
  StudentAlreadyGradedError,
  UnenrollAfterDeadlineError,
} from '../../domain/errors.js';
import type { StudentDroppedPayload, StudentWithdrewPayload } from '../../domain/events.js';

// Private to this slice
function enrollmentStream(studentId: string, courseId: string) {
  return query([
    { types: ['StudentEnrolled'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentDropped'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentWithdrew'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentGraded'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentPassedCourse'], tags: [`student:${studentId}`, `course:${courseId}`] },
    { types: ['StudentFailedCourse'], tags: [`student:${studentId}`, `course:${courseId}`] },
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
export type EnrollmentUnenrollState = {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
};

export function reduceEnrollmentForUnenroll(events: StoredEvent[]): EnrollmentUnenrollState {
  let status: EnrollmentUnenrollState['status'] = 'none';
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

export type CourseUnenrollState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  dropDeadline?: string;
  withdrawalDeadline?: string;
};

export function reduceCourseForUnenroll(events: StoredEvent[]): CourseUnenrollState {
  let state: CourseUnenrollState = { status: 'none' };
  for (const event of events) {
    const p = event.data;
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

export interface UnenrollStudentInput {
  studentId: string;
  courseId: string;
  reason: string;
  unenrolledBy: string;
}

export async function unenrollStudent(
  store: EventStore,
  clock: Clock,
  input: UnenrollStudentInput,
): Promise<void> {
  const allStreams = combineQueries(
    enrollmentStream(input.studentId, input.courseId),
    courseStream(input.courseId),
  );
  
  const { events, version } = await store.load(allStreams);
  
  const enrollmentEvents = events.filter(e => 
    e.tags.includes(`student:${input.studentId}`) && e.tags.includes(`course:${input.courseId}`)
  );
  const courseEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['CourseCreated', 'CoursePublished', 'CourseClosed', 'CourseCancelled', 'TeacherAssignedToCourse', 'TeacherRemovedFromCourse'].includes(e.type)
  );

  const enrollmentState = reduceEnrollmentForUnenroll(enrollmentEvents);

  if (enrollmentState.status === 'none' || enrollmentState.status === 'dropped' || enrollmentState.status === 'withdrew') {
    throw new StudentNotEnrolledError(
      `Student '${input.studentId}' is not enrolled in course '${input.courseId}'`,
    );
  }

  if (enrollmentState.status === 'graded' || enrollmentState.status === 'passed' || enrollmentState.status === 'failed') {
    throw new StudentAlreadyGradedError(
      `Student '${input.studentId}' has already been graded in course '${input.courseId}'`,
    );
  }

  const courseState = reduceCourseForUnenroll(courseEvents);
  const now = clock.now();

  if (courseState.withdrawalDeadline && now > new Date(courseState.withdrawalDeadline)) {
    throw new UnenrollAfterDeadlineError(
      `Cannot unenroll student '${input.studentId}' from course '${input.courseId}' after withdrawal deadline`,
    );
  }

  let event: NewEvent;
  if (courseState.dropDeadline && now <= new Date(courseState.dropDeadline)) {
    const data: StudentDroppedPayload = {
      studentId: input.studentId,
      courseId: input.courseId,
      droppedAt: now.toISOString(),
      droppedBy: input.unenrolledBy,
    };
    event = { type: 'StudentDropped', data: data as unknown as Record<string, unknown>} as NewEvent;
  } else {
    const data: StudentWithdrewPayload = {
      studentId: input.studentId,
      courseId: input.courseId,
      withdrewAt: now.toISOString(),
      withdrewBy: input.unenrolledBy,
    };
    event = { type: 'StudentWithdrew', data: data as unknown as Record<string, unknown>} as NewEvent;
  }

  await store.append(
    [event],
    { failIfEventsMatch: allStreams, after: version },
  );
}
