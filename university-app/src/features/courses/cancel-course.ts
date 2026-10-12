import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem, combineQueries } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  CourseNotFoundError,
  CourseAlreadyCancelledError,
} from '../../domain/errors.js';
import type {
  CourseCancelledPayload,
  StudentDroppedPayload,
  StudentWithdrewPayload,
} from '../../domain/events.js';

// Private to this slice
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

function courseEnrollmentStream(courseId: string) {
  return query([
    { types: ['StudentEnrolled'], tags: [`course:${courseId}`] },
    { types: ['StudentDropped'], tags: [`course:${courseId}`] },
    { types: ['StudentWithdrew'], tags: [`course:${courseId}`] },
  ]);
}

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

// Exported reducers (for unit tests)
export type CourseCancelState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  dropDeadline?: string;
  withdrawalDeadline?: string;
};

export function reduceCourseForCancel(events: StoredEvent[]): CourseCancelState {
  let state: CourseCancelState = { status: 'none' };
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
  const allStreams = combineQueries(
    courseStream(input.courseId),
    courseEnrollmentStream(input.courseId),
  );
  
  const { events, version } = await store.load(allStreams);
  
  const courseEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['CourseCreated', 'CoursePublished', 'CourseClosed', 'CourseCancelled', 'TeacherAssignedToCourse', 'TeacherRemovedFromCourse'].includes(e.type)
  );
  const courseEnrollEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['StudentEnrolled', 'StudentDropped', 'StudentWithdrew'].includes(e.type)
  );

  const courseState = reduceCourseForCancel(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status === 'cancelled') {
    throw new CourseAlreadyCancelledError(`Course '${input.courseId}' is already cancelled`);
  }

  const studentIds = new Set<string>();
  for (const event of courseEnrollEvents) {
    if (event.type === 'StudentEnrolled') {
      studentIds.add(event.data['studentId'] as string);
    }
  }

  const now = clock.now();
  const unenrollEvents: NewEvent[] = [];

  for (const studentId of studentIds) {
    const { events: perStudentEvents } = await store.load(
      enrollmentStream(studentId, input.courseId),
    );
    const enrollmentState = reduceEnrollmentForCancel(perStudentEvents);

    if (enrollmentState.status !== 'enrolled') continue;

    if (courseState.dropDeadline && now <= new Date(courseState.dropDeadline)) {
      const data: StudentDroppedPayload = {
        studentId,
        courseId: input.courseId,
        droppedAt: now.toISOString(),
        droppedBy: 'system',
      };
      unenrollEvents.push({ type: 'StudentDropped', data: data as unknown as Record<string, unknown>} as NewEvent);
    } else {
      const data: StudentWithdrewPayload = {
        studentId,
        courseId: input.courseId,
        withdrewAt: now.toISOString(),
        withdrewBy: 'system',
      };
      unenrollEvents.push({ type: 'StudentWithdrew', data: data as unknown as Record<string, unknown>} as NewEvent);
    }
  }

  const cancelPayload: CourseCancelledPayload = {
    courseId: input.courseId,
    reason: input.reason,
    cancelledAt: now.toISOString(),
  };

  await store.append(
    [...unenrollEvents, { type: 'CourseCancelled', data: cancelPayload as unknown as Record<string, unknown>} as NewEvent],
    {
      failIfEventsMatch: allStreams,
      after: version,
    },
  );
}
