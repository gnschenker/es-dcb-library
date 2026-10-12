import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  StudentNotFoundError,
  CourseNotFoundError,
  CourseNotOpenError,
  StudentAlreadyEnrolledError,
  EnrollmentFullError,
  PrerequisiteNotSatisfiedError,
} from '../../domain/errors.js';
import type { StudentEnrolledPayload } from '../../domain/events.js';

// Private to this slice
function studentStream(studentId: string) {
  return query([
    { types: ['StudentRegistered'], tags: [`student:${studentId}`] },
    { types: ['StudentPassedCourse'], tags: [`student:${studentId}`] },
    { types: ['StudentFailedCourse'], tags: [`student:${studentId}`] },
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

function courseEnrollmentStream(courseId: string) {
  return query([
    { types: ['StudentEnrolled'], tags: [`course:${courseId}`] },
    { types: ['StudentDropped'], tags: [`course:${courseId}`] },
    { types: ['StudentWithdrew'], tags: [`course:${courseId}`] },
  ]);
}

// Exported reducers (for unit tests)
export type StudentEnrollState = {
  registered: boolean;
  completedCourses: Map<string, 'passed' | 'failed'>;
};

export function reduceStudentForEnroll(events: StoredEvent[]): StudentEnrollState {
  let registered = false;
  const completedCourses = new Map<string, 'passed' | 'failed'>();
  for (const event of events) {
    if (event.type === 'StudentRegistered') {
      registered = true;
    } else if (event.type === 'StudentPassedCourse') {
      completedCourses.set(event.data['courseId'] as string, 'passed');
    } else if (event.type === 'StudentFailedCourse') {
      completedCourses.set(event.data['courseId'] as string, 'failed');
    }
  }
  return { registered, completedCourses };
}

export type CourseEnrollState = {
  status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  maxStudents?: number;
  prerequisites?: string[];
  passingGrade?: number;
  creditHours?: number;
  semester?: string;
};

export function reduceCourseForEnroll(events: StoredEvent[]): CourseEnrollState {
  let state: CourseEnrollState = { status: 'none' };
  for (const event of events) {
    const p = event.data;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        maxStudents: p['maxStudents'] as number,
        prerequisites: p['prerequisites'] as string[],
        passingGrade: p['passingGrade'] as number,
        creditHours: p['creditHours'] as number,
        semester: p['semester'] as string,
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

export type EnrollmentEnrollState = {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
};

export function reduceEnrollmentForEnroll(events: StoredEvent[]): EnrollmentEnrollState {
  let status: EnrollmentEnrollState['status'] = 'none';
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

export function reduceEnrollmentCountForEnroll(events: StoredEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'StudentEnrolled') count += 1;
    else if (event.type === 'StudentDropped') count -= 1;
    else if (event.type === 'StudentWithdrew') count -= 1;
  }
  return Math.max(0, count);
}

export interface EnrollStudentInput {
  studentId: string;
  courseId: string;
}

export async function enrollStudent(
  store: EventStore,
  clock: Clock,
  input: EnrollStudentInput,
): Promise<void> {
  const [
    { events: studentEvents },
    { events: courseEvents },
    { events: enrollmentEvents, version: enrollmentVersion },
    { events: courseEnrollEvents, version: courseEnrollVersion },
  ] = await Promise.all([
    store.load(studentStream(input.studentId)),
    store.load(courseStream(input.courseId)),
    store.load(enrollmentStream(input.studentId, input.courseId)),
    store.load(courseEnrollmentStream(input.courseId)),
  ]);

  const studentState = reduceStudentForEnroll(studentEvents);
  if (!studentState.registered) {
    throw new StudentNotFoundError(`Student '${input.studentId}' not found`);
  }

  const courseState = reduceCourseForEnroll(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status !== 'open') {
    throw new CourseNotOpenError(
      `Course '${input.courseId}' is not open (current: ${courseState.status})`,
    );
  }

  const enrollmentState = reduceEnrollmentForEnroll(enrollmentEvents);
  if (enrollmentState.status === 'enrolled' || enrollmentState.status === 'graded') {
    throw new StudentAlreadyEnrolledError(
      `Student '${input.studentId}' is already enrolled in course '${input.courseId}'`,
    );
  }

  const enrollmentCount = reduceEnrollmentCountForEnroll(courseEnrollEvents);
  if (enrollmentCount >= courseState.maxStudents!) {
    throw new EnrollmentFullError(
      `Course '${input.courseId}' is full (${enrollmentCount}/${courseState.maxStudents!} students)`,
    );
  }

  for (const prereqId of courseState.prerequisites ?? []) {
    if (studentState.completedCourses.get(prereqId) !== 'passed') {
      throw new PrerequisiteNotSatisfiedError(
        `Student '${input.studentId}' has not passed prerequisite course '${prereqId}'`,
      );
    }
  }

  const data: StudentEnrolledPayload = {
    studentId: input.studentId,
    courseId: input.courseId,
    enrolledAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'StudentEnrolled', data: data as unknown as Record<string, unknown>} as NewEvent],
    {
      failIfEventsMatch: query([
        ...enrollmentStream(input.studentId, input.courseId).items,
        ...courseEnrollmentStream(input.courseId).items,
      ]),
      after: enrollmentVersion > courseEnrollVersion ? enrollmentVersion : courseEnrollVersion,
    },
  );
}
