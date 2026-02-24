import { describe, it, expect, beforeEach } from 'vitest';
import { query } from 'es-dcb-library';
import { createTestStore, clearEvents } from '../../../../tests/integration/helpers.js';
import { systemClock } from '../../../domain/clock.js';
import type { Clock } from '../../../domain/clock.js';
import { hireTeacher } from '../../teachers/hire-teacher.js';
import { createCourse } from '../../courses/create-course.js';
import { publishCourse } from '../../courses/publish-course.js';
import { closeCourse } from '../../courses/close-course.js';
import { assignTeacher } from '../../teachers/assign-teacher.js';
import { registerStudent } from '../../students/register-student.js';
import { enrollStudent } from '../enroll-student.js';
import { unenrollStudent } from '../unenroll-student.js';
import { gradeStudent } from '../grade-student.js';
import { reduceStudentForEnroll } from '../enroll-student.js';
import {
  CourseNotOpenError,
  StudentAlreadyEnrolledError,
  EnrollmentFullError,
  PrerequisiteNotSatisfiedError,
  StudentAlreadyGradedError,
  UnenrollAfterDeadlineError,
  WrongTeacherError,
  CourseHasActiveEnrollmentsError,
} from '../../../domain/errors.js';

function makeClock(date: Date): Clock {
  return { now: () => date };
}

const TEACHER = { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' };
const STUDENT = { name: 'Alice', email: 'alice@student.edu', dateOfBirth: '2000-01-01' };

beforeEach(clearEvents);

// Sets up a published course with drop/withdrawal deadlines in 2030 (future)
async function setupFutureCourse(store: ReturnType<typeof createTestStore>, maxStudents = 30) {
  const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
  const { courseId } = await createCourse(store, systemClock, {
    title: 'Intro CS',
    semester: 'Fall 2026',
    creditHours: 3,
    maxStudents,
    prerequisites: [],
    dropDeadline: '2030-09-15',
    withdrawalDeadline: '2030-10-15',
  });
  await assignTeacher(store, systemClock, { courseId, teacherId });
  await publishCourse(store, systemClock, { courseId });
  return { teacherId, courseId };
}

describe('EnrollStudent', () => {
  it('happy path — StudentEnrolled', async () => {
    const store = createTestStore();
    const { courseId } = await setupFutureCourse(store);
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId });

    const s = query
      .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['studentId']).toBe(studentId);
    await store.close();
  });

  it('course not open (draft) → CourseNotOpenError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await createCourse(store, systemClock, {
        title: 'Draft CS', semester: 'F26', creditHours: 3, maxStudents: 30,
        prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
      });
      const { studentId } = await registerStudent(store, systemClock, STUDENT);
      await expect(enrollStudent(store, systemClock, { studentId, courseId })).rejects.toThrow(CourseNotOpenError);
    } finally {
      await store.close();
    }
  });

  it('already enrolled → StudentAlreadyEnrolledError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await setupFutureCourse(store);
      const { studentId } = await registerStudent(store, systemClock, STUDENT);
      await enrollStudent(store, systemClock, { studentId, courseId });
      await expect(enrollStudent(store, systemClock, { studentId, courseId })).rejects.toThrow(StudentAlreadyEnrolledError);
    } finally {
      await store.close();
    }
  });

  it('course full (maxStudents: 1, one already enrolled) → EnrollmentFullError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await setupFutureCourse(store, 1);
      const { studentId: s1 } = await registerStudent(store, systemClock, STUDENT);
      const { studentId: s2 } = await registerStudent(store, systemClock, { name: 'Bob', email: 'bob@student.edu', dateOfBirth: '2000-01-02' });
      await enrollStudent(store, systemClock, { studentId: s1, courseId });
      await expect(enrollStudent(store, systemClock, { studentId: s2, courseId })).rejects.toThrow(EnrollmentFullError);
    } finally {
      await store.close();
    }
  });

  it('unsatisfied prerequisite → PrerequisiteNotSatisfiedError (BR-E4)', async () => {
    const store = createTestStore();
    try {
      // Create prereq course
      const { courseId: prereqId } = await createCourse(store, systemClock, {
        title: 'Prereq', semester: 'F25', creditHours: 3, maxStudents: 30,
        prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
      });
      // Create main course with prereq
      const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
      const { courseId } = await createCourse(store, systemClock, {
        title: 'Advanced CS', semester: 'F26', creditHours: 3, maxStudents: 30,
        prerequisites: [prereqId], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
      });
      await assignTeacher(store, systemClock, { courseId, teacherId });
      await publishCourse(store, systemClock, { courseId });
      const { studentId } = await registerStudent(store, systemClock, STUDENT);
      await expect(enrollStudent(store, systemClock, { studentId, courseId }))
        .rejects.toThrow(PrerequisiteNotSatisfiedError);
    } finally {
      await store.close();
    }
  });

  it('satisfied prerequisite (student passed required course) → succeeds', async () => {
    const store = createTestStore();
    // Setup prereq course
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId: prereqId } = await createCourse(store, systemClock, {
      title: 'Prereq', semester: 'F25', creditHours: 3, maxStudents: 30,
      prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId: prereqId, teacherId });
    await publishCourse(store, systemClock, { courseId: prereqId });
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId: prereqId });
    await gradeStudent(store, systemClock, { studentId, courseId: prereqId, grade: 85, gradedBy: teacherId });

    // Now enroll in the advanced course that requires prereq
    const { courseId: advancedId } = await createCourse(store, systemClock, {
      title: 'Advanced CS', semester: 'F26', creditHours: 3, maxStudents: 30,
      prerequisites: [prereqId], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    const { teacherId: t2 } = await hireTeacher(store, systemClock, { name: 'Dr. Jones', email: 'jones@uni.edu', department: 'CS' });
    await assignTeacher(store, systemClock, { courseId: advancedId, teacherId: t2 });
    await publishCourse(store, systemClock, { courseId: advancedId });
    await enrollStudent(store, systemClock, { studentId, courseId: advancedId }); // should succeed
    await store.close();
  });
});

describe('UnenrollStudent', () => {
  async function setupEnrolled(store: ReturnType<typeof createTestStore>) {
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'F26', creditHours: 3, maxStudents: 30,
      prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId });
    return { teacherId, courseId, studentId };
  }

  it('before drop deadline → StudentDropped', async () => {
    const store = createTestStore();
    const { courseId, studentId } = await setupEnrolled(store);
    // Drop deadline is 2030-09-15; clock is before that
    await unenrollStudent(store, systemClock, { studentId, courseId, reason: 'personal', unenrolledBy: studentId });

    const s = query
      .eventsOfType('StudentDropped').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    await store.close();
  });

  it('after drop deadline, before withdrawal deadline → StudentWithdrew', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'F26', creditHours: 3, maxStudents: 30,
      prerequisites: [], dropDeadline: '2020-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId });

    // Use clock that is past drop deadline (2020-09-15) but before withdrawal deadline (2030-10-15)
    const fakeClock = makeClock(new Date('2025-01-01'));
    await unenrollStudent(store, fakeClock, { studentId, courseId, reason: 'conflict', unenrolledBy: studentId });

    const s = query
      .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    await store.close();
  });

  it('after withdrawal deadline → UnenrollAfterDeadlineError', async () => {
    const store = createTestStore();
    try {
      const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
      const { courseId } = await createCourse(store, systemClock, {
        title: 'Intro CS', semester: 'F26', creditHours: 3, maxStudents: 30,
        prerequisites: [], dropDeadline: '2020-09-15', withdrawalDeadline: '2020-10-15',
      });
      await assignTeacher(store, systemClock, { courseId, teacherId });
      await publishCourse(store, systemClock, { courseId });
      const { studentId } = await registerStudent(store, systemClock, STUDENT);
      await enrollStudent(store, systemClock, { studentId, courseId });

      // Both deadlines in the past — system clock is after 2020
      await expect(
        unenrollStudent(store, systemClock, { studentId, courseId, reason: 'late', unenrolledBy: studentId }),
      ).rejects.toThrow(UnenrollAfterDeadlineError);
    } finally {
      await store.close();
    }
  });

  it('after student already graded → StudentAlreadyGradedError (BR-E9)', async () => {
    const store = createTestStore();
    try {
      const { teacherId, courseId, studentId } = await setupEnrolled(store);
      await gradeStudent(store, systemClock, { studentId, courseId, grade: 85, gradedBy: teacherId });
      await expect(
        unenrollStudent(store, systemClock, { studentId, courseId, reason: 'late', unenrolledBy: studentId }),
      ).rejects.toThrow(StudentAlreadyGradedError);
    } finally {
      await store.close();
    }
  });
});

describe('GradeStudent', () => {
  async function setupEnrolled(store: ReturnType<typeof createTestStore>) {
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'Fall 2026', creditHours: 3, maxStudents: 30,
      prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId });
    return { teacherId, courseId, studentId };
  }

  it('passing grade → StudentGraded + StudentPassedCourse (with creditHours, semester)', async () => {
    const store = createTestStore();
    const { teacherId, courseId, studentId } = await setupEnrolled(store);
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 85, gradedBy: teacherId });

    const s = query
      .eventsOfType('StudentGraded').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
      .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events.some(e => e.type === 'StudentGraded')).toBe(true);
    const passed = events.find(e => e.type === 'StudentPassedCourse');
    expect(passed).toBeDefined();
    expect(passed?.payload['creditHours']).toBe(3);
    expect(passed?.payload['semester']).toBe('Fall 2026');
    await store.close();
  });

  it('failing grade → StudentGraded + StudentFailedCourse', async () => {
    const store = createTestStore();
    const { teacherId, courseId, studentId } = await setupEnrolled(store);
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 45, gradedBy: teacherId });

    const s = query
      .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    await store.close();
  });

  it('wrong teacher → WrongTeacherError (BR-E5)', async () => {
    const store = createTestStore();
    try {
      const { courseId, studentId } = await setupEnrolled(store);
      const { teacherId: wrongTeacher } = await hireTeacher(store, systemClock, {
        name: 'Dr. Wrong', email: 'wrong@uni.edu', department: 'Math',
      });
      await expect(
        gradeStudent(store, systemClock, { studentId, courseId, grade: 75, gradedBy: wrongTeacher }),
      ).rejects.toThrow(WrongTeacherError);
    } finally {
      await store.close();
    }
  });

  // TeacherDismissedError in gradeStudent cannot be triggered in integration tests:
  // BR-T4 prevents dismissing a teacher assigned to an open course, and grading requires an open
  // course. The only scenario where a dismissed teacher could match course.teacherId is if we
  // set up the course with teacher T1, then change to T2, dismiss T1, and try grading with T1 —
  // but that triggers WrongTeacherError first (guard ordering). Covered by unit tests.

  // CourseNotOpenError in gradeStudent cannot be triggered in integration tests:
  // Closing a course requires zero active enrollments (all graded/dropped/withdrew). Once graded,
  // StudentAlreadyGradedError fires before CourseNotOpenError. Covered by unit tests.

  it('CloseCourse with enrolled students → CourseHasActiveEnrollmentsError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await setupEnrolled(store);
      // Student is enrolled but not graded — close should be blocked
      await expect(closeCourse(store, systemClock, { courseId })).rejects.toThrow(CourseHasActiveEnrollmentsError);
    } finally {
      await store.close();
    }
  });

  it('CloseCourse after all students graded → succeeds', async () => {
    const store = createTestStore();
    const { teacherId, courseId, studentId } = await setupEnrolled(store);
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 85, gradedBy: teacherId });
    // Now close should succeed (graded students do not block close)
    await closeCourse(store, systemClock, { courseId });

    const s = query.eventsOfType('CourseClosed').where.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    await store.close();
  });
});

describe('Full lifecycle smoke test', () => {
  it('HireTeacher → CreateCourse → AssignTeacher → PublishCourse → RegisterStudent → EnrollStudent → GradeStudent (passing) → StudentPassedCourse', async () => {
    const store = createTestStore();

    // 1. Hire teacher
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);

    // 2. Create course
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'Fall 2026', creditHours: 3, maxStudents: 30,
      prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });

    // 3. Assign teacher and publish
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });

    // 4. Register student and enroll
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    await enrollStudent(store, systemClock, { studentId, courseId });

    // 5. Grade with passing grade
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 90, gradedBy: teacherId });

    // 6. Verify StudentPassedCourse was emitted
    const passedStream = query
      .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
    const { events } = await store.load(passedStream);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['finalGrade']).toBe(90);
    expect(events[0]?.payload['creditHours']).toBe(3);
    expect(events[0]?.payload['semester']).toBe('Fall 2026');

    await store.close();
  });
});

describe('Re-take test', () => {
  it('fail course → re-enroll → pass → completedCourses returns passed', async () => {
    const store = createTestStore();

    // Setup course and teacher
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'Fall 2026', creditHours: 3, maxStudents: 30,
      prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });
    const { studentId } = await registerStudent(store, systemClock, STUDENT);

    // First attempt: fail
    await enrollStudent(store, systemClock, { studentId, courseId });
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 40, gradedBy: teacherId });

    // Re-enroll (should work since student failed, not just dropped)
    await enrollStudent(store, systemClock, { studentId, courseId });

    // Second attempt: pass
    await gradeStudent(store, systemClock, { studentId, courseId, grade: 75, gradedBy: teacherId });

    // Verify: load studentStream and check completedCourses
    const studentStream = query
      .eventsOfType('StudentRegistered').where.key('studentId').equals(studentId)
      .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
      .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
    const { events } = await store.load(studentStream);
    const state = reduceStudentForEnroll(events);
    expect(state.completedCourses.get(courseId)).toBe('passed');

    await store.close();
  });
});
