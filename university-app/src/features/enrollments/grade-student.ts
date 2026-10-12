import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem, combineQueries } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  InvalidGradeError,
  StudentNotEnrolledError,
  StudentAlreadyGradedError,
  CourseNotOpenError,
  WrongTeacherError,
  TeacherDismissedError,
} from '../../domain/errors.js';
import type {
  StudentGradedPayload,
  StudentPassedCoursePayload,
  StudentFailedCoursePayload,
} from '../../domain/events.js';

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

function teacherStream(teacherId: string) {
  return query([
    { types: ['TeacherHired'], tags: [`teacher:${teacherId}`] },
    { types: ['TeacherDismissed'], tags: [`teacher:${teacherId}`] },
  ]);
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
    const p = event.data;
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

  const allStreams = combineQueries(
    enrollmentStream(input.studentId, input.courseId),
    courseStream(input.courseId),
    teacherStream(input.gradedBy),
  );
  
  const { events, version } = await store.load(allStreams);
  
  const enrollmentEvents = events.filter(e => 
    e.tags.includes(`student:${input.studentId}`) && e.tags.includes(`course:${input.courseId}`)
  );
  const courseEvents = events.filter(e => 
    e.tags.includes(`course:${input.courseId}`) &&
    ['CourseCreated', 'CoursePublished', 'CourseClosed', 'CourseCancelled', 'TeacherAssignedToCourse', 'TeacherRemovedFromCourse'].includes(e.type)
  );
  const teacherEvents = events.filter(e => 
    e.tags.includes(`teacher:${input.gradedBy}`) &&
    ['TeacherHired', 'TeacherDismissed'].includes(e.type)
  );

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
      { type: 'StudentGraded', data: gradedPayload as unknown as Record<string, unknown>} as NewEvent,
      {
        type: passed ? 'StudentPassedCourse' : 'StudentFailedCourse',
        data: outcomePayload as unknown as Record<string, unknown>,
      } as NewEvent,
    ],
    { failIfEventsMatch: allStreams, after: version },
  );
}
