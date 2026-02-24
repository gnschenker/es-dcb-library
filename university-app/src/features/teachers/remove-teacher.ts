import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNoTeacherError,
  CourseHasActiveEnrollmentsError,
} from '../../domain/errors.js';
import type { TeacherRemovedFromCoursePayload } from '../../domain/events.js';

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

// Per-student enrollment stream — includes grading events, giving correct terminal status
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

// Full enrollment status including grading events — same pattern as close-course.ts
export type EnrollmentRemoveState = {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
};

export function reduceEnrollmentForRemove(events: StoredEvent[]): EnrollmentRemoveState {
  let status: EnrollmentRemoveState['status'] = 'none';
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

  if (courseState.status === 'open') {
    // Collect unique student IDs from the course enrollment stream
    const studentIds = new Set<string>();
    for (const event of enrollEvents) {
      if (event.type === 'StudentEnrolled') {
        studentIds.add(event.payload['studentId'] as string);
      }
    }
    // Per-student load: courseEnrollmentStream lacks grading events, so a graded student
    // would incorrectly appear as "enrolled" if we only counted from that stream.
    for (const studentId of studentIds) {
      const { events: perStudentEvents } = await store.load(
        enrollmentStream(studentId, input.courseId),
      );
      const enrollmentState = reduceEnrollmentForRemove(perStudentEvents);
      if (enrollmentState.status === 'enrolled') {
        throw new CourseHasActiveEnrollmentsError(
          `Cannot remove teacher from open course '${input.courseId}' with active enrollments`,
        );
      }
    }
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
