import { describe, it, expect, beforeEach } from 'vitest';
import { query } from 'es-dcb-library';
import { createTestStore, clearEvents } from '../../../../tests/integration/helpers.js';
import { systemClock } from '../../../domain/clock.js';
import { hireTeacher } from '../../teachers/hire-teacher.js';
import { createCourse } from '../create-course.js';
import { publishCourse } from '../publish-course.js';
import { closeCourse } from '../close-course.js';
import { cancelCourse } from '../cancel-course.js';
import { assignTeacher } from '../../teachers/assign-teacher.js';
import { registerStudent } from '../../students/register-student.js';
import { enrollStudent } from '../../enrollments/enroll-student.js';
import {
  InvalidCreditHoursError,
  PrerequisiteNotFoundError,
  CourseNoTeacherError,
  CourseNotOpenError,
  CourseAlreadyCancelledError,
} from '../../../domain/errors.js';

const TEACHER = { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' };
const BASE_COURSE = {
  title: 'Intro CS',
  semester: 'Fall 2026',
  creditHours: 3,
  maxStudents: 30,
  prerequisites: [] as string[],
  dropDeadline: '2030-09-15',
  withdrawalDeadline: '2030-10-15',
};

beforeEach(clearEvents);

async function setupPublishedCourse(store: ReturnType<typeof createTestStore>) {
  const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
  const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
  await assignTeacher(store, systemClock, { courseId, teacherId });
  await publishCourse(store, systemClock, { courseId });
  return { teacherId, courseId };
}

describe('CreateCourse', () => {
  it('happy path — CourseCreated with all fields', async () => {
    const store = createTestStore();
    const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
    expect(courseId).toBeTypeOf('string');

    const courseStream = query
      .eventsOfType('CourseCreated').where.key('courseId').equals(courseId);
    const { events } = await store.load(courseStream);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['title']).toBe('Intro CS');
    expect(events[0]?.payload['creditHours']).toBe(3);
    expect(events[0]?.payload['maxStudents']).toBe(30);
    expect(events[0]?.payload['passingGrade']).toBe(60); // default
    await store.close();
  });

  it('invalid creditHours = 0 → InvalidCreditHoursError', async () => {
    const store = createTestStore();
    try {
      await expect(
        createCourse(store, systemClock, { ...BASE_COURSE, creditHours: 0 }),
      ).rejects.toThrow(InvalidCreditHoursError);
    } finally {
      await store.close();
    }
  });

  it('invalid creditHours = 7 → InvalidCreditHoursError', async () => {
    const store = createTestStore();
    try {
      await expect(
        createCourse(store, systemClock, { ...BASE_COURSE, creditHours: 7 }),
      ).rejects.toThrow(InvalidCreditHoursError);
    } finally {
      await store.close();
    }
  });

  it('non-existent prerequisite → PrerequisiteNotFoundError', async () => {
    const store = createTestStore();
    try {
      await expect(
        createCourse(store, systemClock, { ...BASE_COURSE, prerequisites: ['nonexistent-course-id'] }),
      ).rejects.toThrow(PrerequisiteNotFoundError);
    } finally {
      await store.close();
    }
  });

  it('valid prerequisite (existing courseId) → succeeds', async () => {
    const store = createTestStore();
    const { courseId: prereqId } = await createCourse(store, systemClock, BASE_COURSE);
    const { courseId } = await createCourse(store, systemClock, {
      ...BASE_COURSE,
      title: 'Advanced CS',
      prerequisites: [prereqId],
    });
    expect(courseId).toBeTypeOf('string');
    await store.close();
  });
});

describe('AssignTeacherToCourse', () => {
  it('appends TeacherAssignedToCourse', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
    await assignTeacher(store, systemClock, { courseId, teacherId });

    const s = query
      .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events[0]?.payload['teacherId']).toBe(teacherId);
    await store.close();
  });
});

describe('PublishCourse', () => {
  it('happy path — CoursePublished', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });

    const s = query
      .eventsOfType('CoursePublished').where.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['teacherId']).toBe(teacherId);
    await store.close();
  });

  it('no assigned teacher → CourseNoTeacherError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
      await expect(publishCourse(store, systemClock, { courseId })).rejects.toThrow(CourseNoTeacherError);
    } finally {
      await store.close();
    }
  });
});

describe('CloseCourse', () => {
  it('happy path — CourseClosed (no active enrollments)', async () => {
    const store = createTestStore();
    const { courseId } = await setupPublishedCourse(store);
    await closeCourse(store, systemClock, { courseId });

    const s = query.eventsOfType('CourseClosed').where.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    await store.close();
  });

  it('course not open → CourseNotOpenError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await createCourse(store, systemClock, BASE_COURSE); // draft
      await expect(closeCourse(store, systemClock, { courseId })).rejects.toThrow(CourseNotOpenError);
    } finally {
      await store.close();
    }
  });
});

describe('CancelCourse', () => {
  it('cancel draft course (no enrollments) → CourseCancelled', async () => {
    const store = createTestStore();
    const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
    await cancelCourse(store, systemClock, { courseId, reason: 'low enrollment' });

    const s = query.eventsOfType('CourseCancelled').where.key('courseId').equals(courseId);
    const { events } = await store.load(s);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['reason']).toBe('low enrollment');
    await store.close();
  });

  it('cancel already cancelled → CourseAlreadyCancelledError', async () => {
    const store = createTestStore();
    try {
      const { courseId } = await createCourse(store, systemClock, BASE_COURSE);
      await cancelCourse(store, systemClock, { courseId, reason: 'first' });
      await expect(
        cancelCourse(store, systemClock, { courseId, reason: 'second' }),
      ).rejects.toThrow(CourseAlreadyCancelledError);
    } finally {
      await store.close();
    }
  });

  it('cancel open course with enrolled students → StudentDropped + CourseCancelled', async () => {
    const store = createTestStore();
    const { courseId } = await setupPublishedCourse(store);

    const { studentId } = await registerStudent(store, systemClock, {
      name: 'Alice',
      email: 'alice@student.edu',
      dateOfBirth: '2000-01-01',
    });
    await enrollStudent(store, systemClock, { studentId, courseId });

    await cancelCourse(store, systemClock, { courseId, reason: 'cancelled' });

    const droppedStream = query
      .eventsOfType('StudentDropped').where.key('courseId').equals(courseId);
    const { events: droppedEvents } = await store.load(droppedStream);
    expect(droppedEvents).toHaveLength(1); // exactly one student was enrolled

    const cancelledStream = query
      .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId);
    const { events: cancelledEvents } = await store.load(cancelledStream);
    expect(cancelledEvents).toHaveLength(1);
    await store.close();
  });
});
