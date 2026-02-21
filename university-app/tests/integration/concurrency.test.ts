import { describe, it, expect, beforeEach } from 'vitest';
import { ConcurrencyError } from 'es-dcb-library';
import { createTestStore, clearEvents } from './helpers.js';
import { systemClock } from '../../src/domain/clock.js';
import { hireTeacher } from '../../src/commands/hire-teacher.js';
import { createCourse } from '../../src/commands/create-course.js';
import { publishCourse } from '../../src/commands/publish-course.js';
import { assignTeacher } from '../../src/commands/assign-teacher.js';
import { registerStudent } from '../../src/commands/register-student.js';
import { enrollStudent } from '../../src/commands/enroll-student.js';
import {
  TeacherAlreadyHiredError,
  StudentAlreadyRegisteredError,
  EnrollmentFullError,
} from '../../src/domain/errors.js';

const TEACHER = { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' };

beforeEach(clearEvents);

describe('Concurrency', () => {
  it('two simultaneous EnrollStudent for maxStudents:1 course → exactly 1 fulfilled, 1 rejected', async () => {
    const store = createTestStore();

    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, {
      title: 'Intro CS', semester: 'Fall 2026', creditHours: 3, maxStudents: 1,
      prerequisites: [], dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15',
    });
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });

    const { studentId: s1 } = await registerStudent(store, systemClock, {
      name: 'Alice', email: 'alice@s.edu', dateOfBirth: '2000-01-01',
    });
    const { studentId: s2 } = await registerStudent(store, systemClock, {
      name: 'Bob', email: 'bob@s.edu', dateOfBirth: '2000-01-02',
    });

    // Fire both enrollments concurrently
    const results = await Promise.allSettled([
      enrollStudent(store, systemClock, { studentId: s1, courseId }),
      enrollStudent(store, systemClock, { studentId: s2, courseId }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection should be either ConcurrencyError (advisory lock) or EnrollmentFullError (capacity)
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(
      rejection.reason instanceof ConcurrencyError || rejection.reason instanceof EnrollmentFullError,
    ).toBe(true);

    await store.close();
  });

  it('two simultaneous HireTeacher with same email → exactly 1 succeeds', async () => {
    const results = await Promise.allSettled([
      (async () => {
        const store = createTestStore();
        try {
          return await hireTeacher(store, systemClock, TEACHER);
        } finally {
          await store.close();
        }
      })(),
      (async () => {
        const store = createTestStore();
        try {
          return await hireTeacher(store, systemClock, TEACHER);
        } finally {
          await store.close();
        }
      })(),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(
      rejection.reason instanceof ConcurrencyError || rejection.reason instanceof TeacherAlreadyHiredError,
    ).toBe(true);
  });

  it('two simultaneous RegisterStudent with same email → exactly 1 succeeds', async () => {
    const studentInput = { name: 'Alice', email: 'alice@s.edu', dateOfBirth: '2000-01-01' };

    const results = await Promise.allSettled([
      (async () => {
        const store = createTestStore();
        try {
          return await registerStudent(store, systemClock, studentInput);
        } finally {
          await store.close();
        }
      })(),
      (async () => {
        const store = createTestStore();
        try {
          return await registerStudent(store, systemClock, studentInput);
        } finally {
          await store.close();
        }
      })(),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0] as PromiseRejectedResult;
    expect(
      rejection.reason instanceof ConcurrencyError || rejection.reason instanceof StudentAlreadyRegisteredError,
    ).toBe(true);
  });
});
