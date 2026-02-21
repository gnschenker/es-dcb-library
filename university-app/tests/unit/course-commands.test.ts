import { describe, it, expect, vi } from 'vitest';
import type { StoredEvent, EventStore } from 'es-dcb-library';
import { createCourse } from '../../src/commands/create-course.js';
import { reduceCourseForPublish, reduceTeacherForPublish } from '../../src/commands/publish-course.js';
import { reduceCourseForClose, reduceEnrollmentForClose } from '../../src/commands/close-course.js';
import { reduceCourseForCancel, reduceEnrollmentForCancel } from '../../src/commands/cancel-course.js';
import { reduceCourseForAssign, reduceTeacherForAssign } from '../../src/commands/assign-teacher.js';
import { reduceCourseForRemove, reduceEnrollmentForRemove } from '../../src/commands/remove-teacher.js';
import {
  InvalidCreditHoursError,
  InvalidMaxStudentsError,
  InvalidPassingGradeError,
  PrerequisiteNotFoundError,
} from '../../src/domain/errors.js';
import { systemClock } from '../../src/domain/clock.js';

let pos = 1n;
function makeEvent(type: string, payload: Record<string, unknown>): StoredEvent {
  return {
    globalPosition: pos++,
    eventId: `evt-${String(pos)}`,
    type,
    payload,
    metadata: null,
    occurredAt: new Date(),
  };
}

function makeMockStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    append: vi.fn().mockResolvedValue([]),
    stream: vi.fn().mockReturnValue((async function* () {})()),
    initializeSchema: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as EventStore;
}

// --- createCourse validations ---
describe('createCourse validations', () => {
  it('throws InvalidCreditHoursError for 0 creditHours', async () => {
    const store = makeMockStore();
    await expect(createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 0, maxStudents: 10, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }))
      .rejects.toThrow(InvalidCreditHoursError);
  });

  it('throws InvalidCreditHoursError for 7 creditHours', async () => {
    const store = makeMockStore();
    await expect(createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 7, maxStudents: 10, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }))
      .rejects.toThrow(InvalidCreditHoursError);
  });

  it('accepts creditHours 1 through 6', async () => {
    for (const h of [1, 2, 3, 4, 5, 6]) {
      const store = makeMockStore();
      const result = await createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: h, maxStudents: 10, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' });
      expect(result.courseId).toBeTypeOf('string');
    }
  });

  it('throws InvalidMaxStudentsError for maxStudents < 1', async () => {
    const store = makeMockStore();
    await expect(createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 3, maxStudents: 0, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }))
      .rejects.toThrow(InvalidMaxStudentsError);
  });

  it('throws InvalidPassingGradeError for grade > 100', async () => {
    const store = makeMockStore();
    await expect(createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 3, maxStudents: 10, passingGrade: 101, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }))
      .rejects.toThrow(InvalidPassingGradeError);
  });

  it('defaults passingGrade to 60 when not provided', async () => {
    const store = makeMockStore();
    await createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 3, maxStudents: 10, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string; payload: Record<string, unknown> }>];
    expect(appendCall[0]?.[0]?.payload['passingGrade']).toBe(60);
  });

  it('throws PrerequisiteNotFoundError for non-existent prerequisite', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    });
    await expect(createCourse(store, systemClock, { title: 'T', semester: 'F24', creditHours: 3, maxStudents: 10, prerequisites: ['nonexistent-id'], dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }))
      .rejects.toThrow(PrerequisiteNotFoundError);
  });
});

// --- reduceCourseForPublish ---
describe('reduceCourseForPublish', () => {
  const createdPayload = { courseId: 'c1', title: 'T', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60 };

  it('returns none for empty events', () => {
    expect(reduceCourseForPublish([])).toEqual({ status: 'none' });
  });

  it('sets draft after CourseCreated', () => {
    const state = reduceCourseForPublish([makeEvent('CourseCreated', { ...createdPayload, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })]);
    expect(state.status).toBe('draft');
    expect(state.teacherId).toBeNull();
    expect(state.maxStudents).toBe(30);
  });

  it('tracks teacher assignment', () => {
    const events = [
      makeEvent('CourseCreated', { ...createdPayload, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
    ];
    expect(reduceCourseForPublish(events).teacherId).toBe('t1');
  });
});

// --- reduceTeacherForPublish ---
describe('reduceTeacherForPublish', () => {
  it('returns none for empty', () => expect(reduceTeacherForPublish([]).status).toBe('none'));
  it('returns hired', () => {
    expect(reduceTeacherForPublish([makeEvent('TeacherHired', { teacherId: 't1', name: 'X', email: 'x@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })]).status).toBe('hired');
  });
  it('returns dismissed', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'X', email: 'x@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    expect(reduceTeacherForPublish(events).status).toBe('dismissed');
  });
});

// --- reduceCourseForClose ---
describe('reduceCourseForClose', () => {
  it('returns none for empty', () => expect(reduceCourseForClose([]).status).toBe('none'));
  it('tracks draft → open → closed', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
      makeEvent('CourseClosed', { courseId: 'c1', closedAt: '2024-12-01T00:00:00Z' }),
    ];
    expect(reduceCourseForClose(events).status).toBe('closed');
  });
  it('tracks cancelled', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1' }),
      makeEvent('CourseCancelled', { courseId: 'c1', reason: 'low enrollment', cancelledAt: '2024-02-01T00:00:00Z' }),
    ];
    expect(reduceCourseForClose(events).status).toBe('cancelled');
  });
});

// --- reduceEnrollmentForClose ---
describe('reduceEnrollmentForClose', () => {
  it('returns none for empty', () => expect(reduceEnrollmentForClose([]).status).toBe('none'));
  it('enrolled', () => expect(reduceEnrollmentForClose([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' })]).status).toBe('enrolled'));
  it('graded', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }),
    ];
    expect(reduceEnrollmentForClose(events).status).toBe('graded');
  });
  it('passed', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'F24' }),
    ];
    expect(reduceEnrollmentForClose(events).status).toBe('passed');
  });
});

// --- reduceCourseForCancel ---
describe('reduceCourseForCancel', () => {
  it('returns none for empty', () => expect(reduceCourseForCancel([]).status).toBe('none'));
  it('preserves deadlines from CourseCreated', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'T', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
    ];
    const state = reduceCourseForCancel(events);
    expect(state.dropDeadline).toBe('2024-09-15');
    expect(state.withdrawalDeadline).toBe('2024-10-15');
  });
  it('CoursePublished does not overwrite deadlines', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'T', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    const state = reduceCourseForCancel(events);
    expect(state.status).toBe('open');
    expect(state.dropDeadline).toBe('2024-09-15');
  });
});

// --- reduceEnrollmentForCancel ---
describe('reduceEnrollmentForCancel', () => {
  it('returns none for empty', () => expect(reduceEnrollmentForCancel([]).status).toBe('none'));
  it('enrolled', () => expect(reduceEnrollmentForCancel([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' })]).status).toBe('enrolled'));
  it('graded students are not "enrolled"', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'F24' }),
    ];
    expect(reduceEnrollmentForCancel(events).status).toBe('passed');
  });
});

// --- reduceCourseForAssign ---
describe('reduceCourseForAssign', () => {
  it('returns none for empty', () => expect(reduceCourseForAssign([]).status).toBe('none'));
  it('draft after CourseCreated', () => {
    expect(reduceCourseForAssign([makeEvent('CourseCreated', { courseId: 'c1' })]).status).toBe('draft');
  });
  it('open after CoursePublished', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    expect(reduceCourseForAssign(events).status).toBe('open');
  });
});

// --- reduceTeacherForAssign ---
describe('reduceTeacherForAssign', () => {
  it('none for empty', () => expect(reduceTeacherForAssign([]).status).toBe('none'));
  it('hired', () => expect(reduceTeacherForAssign([makeEvent('TeacherHired', { teacherId: 't1', name: 'X', email: 'x@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })]).status).toBe('hired'));
  it('dismissed', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'X', email: 'x@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    expect(reduceTeacherForAssign(events).status).toBe('dismissed');
  });
});

// --- reduceCourseForRemove ---
describe('reduceCourseForRemove', () => {
  it('returns none for empty', () => expect(reduceCourseForRemove([])).toEqual({ status: 'none' }));
  it('tracks teacherId', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
    ];
    expect(reduceCourseForRemove(events).teacherId).toBe('t1');
  });
  it('teacherId null after removal', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
      makeEvent('TeacherRemovedFromCourse', { courseId: 'c1', teacherId: 't1', removedAt: '2024-01-03T00:00:00Z' }),
    ];
    expect(reduceCourseForRemove(events).teacherId).toBeNull();
  });
});

// --- reduceEnrollmentForRemove ---
describe('reduceEnrollmentForRemove', () => {
  it('returns none for empty', () => expect(reduceEnrollmentForRemove([])).toEqual({ status: 'none' }));
  it('enrolled', () => expect(reduceEnrollmentForRemove([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' })]).status).toBe('enrolled'));
  it('graded is not enrolled', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }),
    ];
    expect(reduceEnrollmentForRemove(events).status).toBe('graded');
  });
  it('passed is not enrolled', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'F24' }),
    ];
    expect(reduceEnrollmentForRemove(events).status).toBe('passed');
  });
});
