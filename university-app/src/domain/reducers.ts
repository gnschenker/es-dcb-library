import type { StoredEvent } from 'es-dcb-library';

export type TeacherStatus = 'none' | 'hired' | 'dismissed';

export interface TeacherState {
  status: TeacherStatus;
  name?: string;
  email?: string;
  department?: string;
}

export function reduceTeacher(events: StoredEvent[]): TeacherState {
  let state: TeacherState = { status: 'none' };
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.type === 'TeacherHired') {
      state = {
        status: 'hired',
        name: p['name'] as string,
        email: p['email'] as string,
        department: p['department'] as string,
      };
    } else if (event.type === 'TeacherDismissed') {
      state = { ...state, status: 'dismissed' };
    }
  }
  return state;
}

export type CourseStatus = 'none' | 'draft' | 'open' | 'closed' | 'cancelled';

export interface CourseState {
  status: CourseStatus;
  title?: string;
  semester?: string;
  creditHours?: number;
  maxStudents?: number;
  prerequisites?: string[];
  passingGrade?: number;
  teacherId?: string | null;
  dropDeadline?: string;
  withdrawalDeadline?: string;
}

export function reduceCourse(events: StoredEvent[]): CourseState {
  let state: CourseState = { status: 'none' };
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        title: p['title'] as string,
        semester: p['semester'] as string,
        creditHours: p['creditHours'] as number,
        maxStudents: p['maxStudents'] as number,
        prerequisites: p['prerequisites'] as string[],
        passingGrade: p['passingGrade'] as number,
        dropDeadline: p['dropDeadline'] as string,
        withdrawalDeadline: p['withdrawalDeadline'] as string,
        teacherId: null,
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

export type EnrollmentStatus = 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';

export interface EnrollmentState {
  status: EnrollmentStatus;
  grade?: number;
}

export function reduceEnrollment(events: StoredEvent[]): EnrollmentState {
  let state: EnrollmentState = { status: 'none' };
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.type === 'StudentEnrolled') {
      state = { status: 'enrolled' };
    } else if (event.type === 'StudentDropped') {
      state = { status: 'dropped' };
    } else if (event.type === 'StudentWithdrew') {
      state = { status: 'withdrew' };
    } else if (event.type === 'StudentGraded') {
      state = { status: 'graded', grade: p['grade'] as number };
    } else if (event.type === 'StudentPassedCourse') {
      state = { ...state, status: 'passed' };
    } else if (event.type === 'StudentFailedCourse') {
      state = { ...state, status: 'failed' };
    }
  }
  return state;
}

export function reduceStudentCompletedCourses(events: StoredEvent[]): Map<string, 'passed' | 'failed'> {
  const result = new Map<string, 'passed' | 'failed'>();
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.type === 'StudentPassedCourse') {
      result.set(p['courseId'] as string, 'passed');
    } else if (event.type === 'StudentFailedCourse') {
      result.set(p['courseId'] as string, 'failed');
    }
  }
  return result;
}

export function reduceEnrollmentCount(events: StoredEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'StudentEnrolled') {
      count++;
    } else if (event.type === 'StudentDropped' || event.type === 'StudentWithdrew') {
      count = Math.max(0, count - 1);
    }
  }
  return count;
}
