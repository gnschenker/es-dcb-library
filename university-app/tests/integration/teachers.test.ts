import { describe, it, expect, beforeEach } from 'vitest';
import { query } from 'es-dcb-library';
import { createTestStore, clearEvents } from './helpers.js';
import { systemClock } from '../../src/domain/clock.js';
import { teacherIdFromEmail } from '../../src/domain/ids.js';
import { hireTeacher } from '../../src/commands/hire-teacher.js';
import { dismissTeacher } from '../../src/commands/dismiss-teacher.js';
import { createCourse } from '../../src/commands/create-course.js';
import { assignTeacher } from '../../src/commands/assign-teacher.js';
import { publishCourse } from '../../src/commands/publish-course.js';
import {
  TeacherAlreadyHiredError,
  TeacherNotFoundError,
  TeacherDismissedError,
  TeacherAssignedToOpenCourseError,
} from '../../src/domain/errors.js';

const TEACHER = { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' };
const COURSE = {
  title: 'Intro CS',
  semester: 'Fall 2026',
  creditHours: 3,
  maxStudents: 30,
  prerequisites: [],
  dropDeadline: '2030-09-15',
  withdrawalDeadline: '2030-10-15',
};

beforeEach(clearEvents);

describe('HireTeacher', () => {
  it('happy path — TeacherHired event with correct payload', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    expect(teacherId).toBe(teacherIdFromEmail(TEACHER.email));

    const teacherStream = query
      .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId);
    const { events } = await store.load(teacherStream);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('TeacherHired');
    expect(events[0]?.payload['name']).toBe('Dr. Smith');
    expect(events[0]?.payload['department']).toBe('CS');
    await store.close();
  });

  it('same email twice → TeacherAlreadyHiredError', async () => {
    const store = createTestStore();
    await hireTeacher(store, systemClock, TEACHER);
    await expect(hireTeacher(store, systemClock, TEACHER)).rejects.toThrow(TeacherAlreadyHiredError);
    await store.close();
  });

  it('deterministic id — same email → same teacherId', async () => {
    const store = createTestStore();
    const { teacherId: id1 } = await hireTeacher(store, systemClock, TEACHER);
    const id2 = teacherIdFromEmail(TEACHER.email);
    expect(id1).toBe(id2);
    await store.close();
  });
});

describe('DismissTeacher', () => {
  it('happy path — TeacherDismissed appended', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    await dismissTeacher(store, systemClock, { teacherId, reason: 'budget cuts' });

    const teacherStream = query
      .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
      .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
    const { events } = await store.load(teacherStream);
    expect(events.some(e => e.type === 'TeacherDismissed')).toBe(true);
    await store.close();
  });

  it('non-existent teacher → TeacherNotFoundError', async () => {
    const store = createTestStore();
    await expect(
      dismissTeacher(store, systemClock, { teacherId: 'nonexistent', reason: 'test' }),
    ).rejects.toThrow(TeacherNotFoundError);
    await store.close();
  });

  it('dismiss twice → TeacherDismissedError on second', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    await dismissTeacher(store, systemClock, { teacherId, reason: 'first' });
    await expect(
      dismissTeacher(store, systemClock, { teacherId, reason: 'second' }),
    ).rejects.toThrow(TeacherDismissedError);
    await store.close();
  });

  it('re-hire after dismissal succeeds', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    await dismissTeacher(store, systemClock, { teacherId, reason: 'budget cuts' });
    // Re-hire with same email — should produce TeacherHired again
    const { teacherId: rehiredId } = await hireTeacher(store, systemClock, TEACHER);
    expect(rehiredId).toBe(teacherId); // Same deterministic ID
    await store.close();
  });

  it('dismiss when assigned to open course → TeacherAssignedToOpenCourseError (BR-T4)', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, COURSE);
    await assignTeacher(store, systemClock, { courseId, teacherId });
    await publishCourse(store, systemClock, { courseId });

    await expect(
      dismissTeacher(store, systemClock, { teacherId, reason: 'cuts' }),
    ).rejects.toThrow(TeacherAssignedToOpenCourseError);
    await store.close();
  });

  it('dismiss when assigned to draft course → auto TeacherRemovedFromCourse + TeacherDismissed', async () => {
    const store = createTestStore();
    const { teacherId } = await hireTeacher(store, systemClock, TEACHER);
    const { courseId } = await createCourse(store, systemClock, COURSE);
    await assignTeacher(store, systemClock, { courseId, teacherId });

    // Dismiss while course is still in draft — should auto-remove teacher from course
    await dismissTeacher(store, systemClock, { teacherId, reason: 'cuts' });

    const courseStream = query
      .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
    const { events: courseEvents } = await store.load(courseStream);
    expect(courseEvents.some(e => e.type === 'TeacherRemovedFromCourse')).toBe(true);

    const teacherStream = query
      .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
    const { events: teacherEvents } = await store.load(teacherStream);
    expect(teacherEvents.some(e => e.type === 'TeacherDismissed')).toBe(true);
    await store.close();
  });
});
