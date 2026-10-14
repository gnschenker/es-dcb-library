import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem, combineQueries } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNotOpenError,
  CourseHasActiveEnrollmentsError,
} from '../../domain/errors.js';
import type { CourseClosedPayload } from '../../domain/events.js';

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
  const allStreams = combineQueries(
    courseStream(input.courseId),
    courseEnrollmentStream(input.courseId),
  );
  
  const { events, position } = await store.load(allStreams);
  
  const courseEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['CourseCreated', 'CoursePublished', 'CourseClosed', 'CourseCancelled', 'TeacherAssignedToCourse', 'TeacherRemovedFromCourse'].includes(e.type)
  );
  const enrollEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['StudentEnrolled', 'StudentDropped', 'StudentWithdrew'].includes(e.type)
  );

  const courseState = reduceCourseForClose(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status !== 'open') {
    throw new CourseNotOpenError(
      `Course '${input.courseId}' is not open (current: ${courseState.status})`,
    );
  }

  const studentIds = new Set<string>();
  for (const event of enrollEvents) {
    if (event.type === 'StudentEnrolled') {
      studentIds.add(event.data['studentId'] as string);
    }
  }

  for (const studentId of studentIds) {
    const { events: perStudentEvents } = await store.load(enrollmentStream(studentId, input.courseId));
    const enrollmentState = reduceEnrollmentForClose(perStudentEvents);
    if (enrollmentState.status === 'enrolled') {
      throw new CourseHasActiveEnrollmentsError(
        `Course '${input.courseId}' has active enrollments and cannot be closed`,
      );
    }
  }

  const data: CourseClosedPayload = {
    courseId: input.courseId,
    closedAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'CourseClosed', data: data as unknown as Record<string, unknown>} as NewEvent],
    { failIfEventsMatch: allStreams, after: position },
  );
}
