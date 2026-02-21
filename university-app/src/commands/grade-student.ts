import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import {
  InvalidGradeError,
  StudentNotEnrolledError,
  StudentAlreadyGradedError,
  CourseNotOpenError,
  WrongTeacherError,
  TeacherDismissedError,
} from '../domain/errors.js';
import type {
  StudentGradedPayload,
  StudentPassedCoursePayload,
  StudentFailedCoursePayload,
} from '../domain/events.js';

// Private to this slice
function enrollmentStream(studentId: string, courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
}

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
export type EnrollmentGradeState = {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
};

export function reduceEnrollmentForGrade(events: StoredEvent[]): EnrollmentGradeState {
  let status: EnrollmentGradeState['status'] = 'none';
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

export type CourseGradeState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  teacherId?: string | null;
  passingGrade?: number;
  creditHours?: number;
  semester?: string;
};

export function reduceCourseForGrade(events: StoredEvent[]): CourseGradeState {
  let state: CourseGradeState = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        teacherId: null,
        passingGrade: p['passingGrade'] as number,
        creditHours: p['creditHours'] as number,
        semester: p['semester'] as string,
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

export type TeacherGradeState = { status: 'none' | 'hired' | 'dismissed' };

export function reduceTeacherForGrade(events: StoredEvent[]): TeacherGradeState {
  let status: 'none' | 'hired' | 'dismissed' = 'none';
  for (const event of events) {
    if (event.type === 'TeacherHired') status = 'hired';
    else if (event.type === 'TeacherDismissed') status = 'dismissed';
  }
  return { status };
}

export interface GradeStudentInput {
  studentId: string;
  courseId: string;
  grade: number;
  gradedBy: string;
}

export async function gradeStudent(
  store: EventStore,
  clock: Clock,
  input: GradeStudentInput,
): Promise<void> {
  if (input.grade < 0 || input.grade > 100) {
    throw new InvalidGradeError(`Grade must be between 0 and 100, got ${input.grade}`);
  }

  const [
    { events: enrollmentEvents, version: enrollmentVersion },
    { events: courseEvents },
    { events: teacherEvents },
  ] = await Promise.all([
    store.load(enrollmentStream(input.studentId, input.courseId)),
    store.load(courseStream(input.courseId)),
    store.load(teacherStream(input.gradedBy)),
  ]);

  const enrollmentState = reduceEnrollmentForGrade(enrollmentEvents);
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

  const courseState = reduceCourseForGrade(courseEvents);
  if (courseState.status !== 'open') {
    throw new CourseNotOpenError(
      `Course '${input.courseId}' is not open (current: ${courseState.status})`,
    );
  }

  if (courseState.teacherId !== input.gradedBy) {
    throw new WrongTeacherError(
      `Teacher '${input.gradedBy}' is not the assigned teacher for course '${input.courseId}'`,
    );
  }

  const teacherState = reduceTeacherForGrade(teacherEvents);
  if (teacherState.status !== 'hired') {
    throw new TeacherDismissedError(
      `Teacher '${input.gradedBy}' is not actively hired`,
    );
  }

  const now = clock.now();
  const gradedPayload: StudentGradedPayload = {
    studentId: input.studentId,
    courseId: input.courseId,
    grade: input.grade,
    gradedBy: input.gradedBy,
    gradedAt: now.toISOString(),
  };

  const passed = input.grade >= courseState.passingGrade!;
  const outcomePayload: StudentPassedCoursePayload | StudentFailedCoursePayload = {
    studentId: input.studentId,
    courseId: input.courseId,
    finalGrade: input.grade,
    creditHours: courseState.creditHours!,
    semester: courseState.semester!,
  };

  await store.append(
    [
      { type: 'StudentGraded', payload: gradedPayload as unknown as Record<string, unknown> } as NewEvent,
      {
        type: passed ? 'StudentPassedCourse' : 'StudentFailedCourse',
        payload: outcomePayload as unknown as Record<string, unknown>,
      } as NewEvent,
    ],
    { query: enrollmentStream(input.studentId, input.courseId), expectedVersion: enrollmentVersion },
  );
}
