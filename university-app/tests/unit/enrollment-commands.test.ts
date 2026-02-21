import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredEvent, EventStore } from 'es-dcb-library';
import {
  reduceStudentForEnroll,
  reduceCourseForEnroll,
  reduceEnrollmentForEnroll,
  reduceEnrollmentCountForEnroll,
  enrollStudent,
} from '../../src/commands/enroll-student.js';
import {
  reduceEnrollmentForUnenroll,
  reduceCourseForUnenroll,
  unenrollStudent,
} from '../../src/commands/unenroll-student.js';
import {
  reduceEnrollmentForGrade,
  reduceCourseForGrade,
  reduceTeacherForGrade,
  gradeStudent,
} from '../../src/commands/grade-student.js';
import {
  StudentNotFoundError,
  CourseNotOpenError,
  StudentAlreadyEnrolledError,
  EnrollmentFullError,
  PrerequisiteNotSatisfiedError,
  StudentNotEnrolledError,
  StudentAlreadyGradedError,
  UnenrollAfterDeadlineError,
  InvalidGradeError,
  WrongTeacherError,
  TeacherDismissedError,
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

beforeEach(() => {
  pos = 1n;
});

// --- reduceStudentForEnroll ---
describe('reduceStudentForEnroll', () => {
  it('returns not registered for empty events', () => {
    const state = reduceStudentForEnroll([]);
    expect(state.registered).toBe(false);
    expect(state.completedCourses.size).toBe(0);
  });

  it('marks registered after StudentRegistered', () => {
    const events = [makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' })];
    expect(reduceStudentForEnroll(events).registered).toBe(true);
  });

  it('records passed course', () => {
    const events = [
      makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' }),
    ];
    const state = reduceStudentForEnroll(events);
    expect(state.completedCourses.get('c1')).toBe('passed');
  });

  it('records failed course', () => {
    const events = [
      makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'Fall 2024' }),
    ];
    const state = reduceStudentForEnroll(events);
    expect(state.completedCourses.get('c1')).toBe('failed');
  });

  it('later outcome overwrites earlier (retake: fail then pass)', () => {
    const events = [
      makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'Fall 2024' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 75, creditHours: 3, semester: 'Spring 2025' }),
    ];
    const state = reduceStudentForEnroll(events);
    expect(state.completedCourses.get('c1')).toBe('passed');
  });

  it('tracks multiple distinct courses', () => {
    const events = [
      makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 80, creditHours: 3, semester: 'Fall 2024' }),
      makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c2', finalGrade: 40, creditHours: 3, semester: 'Fall 2024' }),
    ];
    const state = reduceStudentForEnroll(events);
    expect(state.completedCourses.get('c1')).toBe('passed');
    expect(state.completedCourses.get('c2')).toBe('failed');
  });
});

// --- reduceCourseForEnroll ---
describe('reduceCourseForEnroll', () => {
  it('returns none for empty events', () => {
    expect(reduceCourseForEnroll([]).status).toBe('none');
  });

  it('returns draft after CourseCreated', () => {
    const events = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })];
    const state = reduceCourseForEnroll(events);
    expect(state.status).toBe('draft');
    expect(state.maxStudents).toBe(30);
    expect(state.prerequisites).toEqual([]);
    expect(state.passingGrade).toBe(60);
    expect(state.creditHours).toBe(3);
    expect(state.semester).toBe('F24');
  });

  it('returns open after CoursePublished', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    expect(reduceCourseForEnroll(events).status).toBe('open');
  });

  it('returns closed/cancelled correctly', () => {
    const base = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })];
    expect(reduceCourseForEnroll([...base, makeEvent('CourseClosed', { courseId: 'c1', closedAt: '2024-12-01T00:00:00Z' })]).status).toBe('closed');
    expect(reduceCourseForEnroll([...base, makeEvent('CourseCancelled', { courseId: 'c1', reason: 'x', cancelledAt: '2024-12-01T00:00:00Z' })]).status).toBe('cancelled');
  });
});

// --- reduceEnrollmentForEnroll ---
describe('reduceEnrollmentForEnroll', () => {
  it('returns none for empty events', () => {
    expect(reduceEnrollmentForEnroll([]).status).toBe('none');
  });

  it('tracks enrolled status', () => {
    const events = [makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
    expect(reduceEnrollmentForEnroll(events).status).toBe('enrolled');
  });

  it('tracks dropped status', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' }),
    ];
    expect(reduceEnrollmentForEnroll(events).status).toBe('dropped');
  });

  it('tracks graded status', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 't1', gradedAt: '2024-05-01T00:00:00Z' }),
    ];
    expect(reduceEnrollmentForEnroll(events).status).toBe('graded');
  });

  it('tracks passed/failed outcome', () => {
    const enrolled = [makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
    expect(reduceEnrollmentForEnroll([...enrolled, makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 75, creditHours: 3, semester: 'F24' })]).status).toBe('passed');
    expect(reduceEnrollmentForEnroll([...enrolled, makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'F24' })]).status).toBe('failed');
  });
});

// --- reduceEnrollmentCountForEnroll ---
describe('reduceEnrollmentCountForEnroll', () => {
  it('returns 0 for empty events', () => {
    expect(reduceEnrollmentCountForEnroll([])).toBe(0);
  });

  it('counts enrolled students', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
    ];
    expect(reduceEnrollmentCountForEnroll(events)).toBe(2);
  });

  it('decrements on drop', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' }),
    ];
    expect(reduceEnrollmentCountForEnroll(events)).toBe(0);
  });

  it('decrements on withdrawal', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentWithdrew', { studentId: 's1', courseId: 'c1', withdrewAt: '2024-02-01T00:00:00Z', withdrewBy: 's1' }),
    ];
    expect(reduceEnrollmentCountForEnroll(events)).toBe(0);
  });

  it('never goes below 0', () => {
    const events = [makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' })];
    expect(reduceEnrollmentCountForEnroll(events)).toBe(0);
  });

  it('mixes enrolled, dropped, withdrew correctly', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentEnrolled', { studentId: 's3', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentDropped', { studentId: 's2', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's2' }),
      makeEvent('StudentWithdrew', { studentId: 's3', courseId: 'c1', withdrewAt: '2024-02-01T00:00:00Z', withdrewBy: 's3' }),
    ];
    expect(reduceEnrollmentCountForEnroll(events)).toBe(1);
  });
});

// --- reduceEnrollmentForUnenroll ---
describe('reduceEnrollmentForUnenroll', () => {
  it('returns none for empty events', () => {
    expect(reduceEnrollmentForUnenroll([]).status).toBe('none');
  });

  it('tracks through full lifecycle', () => {
    expect(reduceEnrollmentForUnenroll([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })]).status).toBe('enrolled');
    expect(reduceEnrollmentForUnenroll([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 80, gradedBy: 't1', gradedAt: '2024-05-01T00:00:00Z' })]).status).toBe('graded');
  });
});

// --- reduceCourseForUnenroll ---
describe('reduceCourseForUnenroll', () => {
  it('returns none for empty events', () => {
    expect(reduceCourseForUnenroll([]).status).toBe('none');
  });

  it('preserves deadlines after publish', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    const state = reduceCourseForUnenroll(events);
    expect(state.status).toBe('open');
    expect(state.dropDeadline).toBe('2024-09-15');
    expect(state.withdrawalDeadline).toBe('2024-10-15');
  });
});

// --- reduceEnrollmentForGrade ---
describe('reduceEnrollmentForGrade', () => {
  it('returns none for empty events', () => {
    expect(reduceEnrollmentForGrade([]).status).toBe('none');
  });

  it('tracks enrolled, graded, passed, failed', () => {
    const enrolled = makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' });
    expect(reduceEnrollmentForGrade([enrolled]).status).toBe('enrolled');
    expect(reduceEnrollmentForGrade([enrolled, makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 80, gradedBy: 't1', gradedAt: '2024-05-01T00:00:00Z' })]).status).toBe('graded');
    expect(reduceEnrollmentForGrade([enrolled, makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 80, creditHours: 3, semester: 'F24' })]).status).toBe('passed');
    expect(reduceEnrollmentForGrade([enrolled, makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 40, creditHours: 3, semester: 'F24' })]).status).toBe('failed');
  });
});

// --- reduceCourseForGrade ---
describe('reduceCourseForGrade', () => {
  it('returns none for empty events', () => {
    expect(reduceCourseForGrade([]).status).toBe('none');
  });

  it('captures passingGrade, creditHours, semester from CourseCreated', () => {
    const events = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 70, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })];
    const state = reduceCourseForGrade(events);
    expect(state.passingGrade).toBe(70);
    expect(state.creditHours).toBe(3);
    expect(state.semester).toBe('F24');
    expect(state.teacherId).toBeNull();
  });

  it('tracks teacher assignment and removal', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
    ];
    expect(reduceCourseForGrade(events).teacherId).toBe('t1');
    expect(reduceCourseForGrade([...events, makeEvent('TeacherRemovedFromCourse', { courseId: 'c1', teacherId: 't1', removedAt: '2024-01-03T00:00:00Z' })]).teacherId).toBeNull();
  });

  it('tracks open/closed/cancelled status', () => {
    const base = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })];
    expect(reduceCourseForGrade([...base, makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 })]).status).toBe('open');
    expect(reduceCourseForGrade([...base, makeEvent('CourseClosed', { courseId: 'c1', closedAt: '2024-12-01T00:00:00Z' })]).status).toBe('closed');
  });
});

// --- reduceTeacherForGrade ---
describe('reduceTeacherForGrade', () => {
  it('returns none for empty events', () => {
    expect(reduceTeacherForGrade([]).status).toBe('none');
  });

  it('returns hired after TeacherHired', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];
    expect(reduceTeacherForGrade(events).status).toBe('hired');
  });

  it('returns dismissed after TeacherDismissed', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    expect(reduceTeacherForGrade(events).status).toBe('dismissed');
  });
});

// --- enrollStudent command ---
describe('enrollStudent command', () => {
  const openCourseEvents = [
    makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' }),
    makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
  ];
  const registeredStudentEvents = [
    makeEvent('StudentRegistered', { studentId: 's1', name: 'Alice', email: 'a@u.edu', dateOfBirth: '2000-01-01', registeredAt: '2024-01-01T00:00:00Z' }),
  ];

  it('appends StudentEnrolled on success', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: registeredStudentEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n })
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: [], version: 0n }),
    });
    await enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' });
    expect(store.append).toHaveBeenCalledOnce();
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('StudentEnrolled');
  });

  it('throws StudentNotFoundError when student not registered', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n })
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: [], version: 0n }),
    });
    await expect(enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' }))
      .rejects.toThrow(StudentNotFoundError);
  });

  it('throws CourseNotOpenError when course is not open', async () => {
    const draftCourse = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' })];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: registeredStudentEvents, version: 1n })
        .mockResolvedValueOnce({ events: draftCourse, version: 1n })
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: [], version: 0n }),
    });
    await expect(enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' }))
      .rejects.toThrow(CourseNotOpenError);
  });

  it('throws StudentAlreadyEnrolledError when already enrolled', async () => {
    const enrolledEvents = [makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: registeredStudentEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n })
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n }),
    });
    await expect(enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' }))
      .rejects.toThrow(StudentAlreadyEnrolledError);
  });

  it('throws EnrollmentFullError when at capacity', async () => {
    const fullCourseEvents = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 1, prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 1, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    const existingEnrollment = [makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: registeredStudentEvents, version: 1n })
        .mockResolvedValueOnce({ events: fullCourseEvents, version: 2n })
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: existingEnrollment, version: 1n }),
    });
    await expect(enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' }))
      .rejects.toThrow(EnrollmentFullError);
  });

  it('throws PrerequisiteNotSatisfiedError when prereq not passed', async () => {
    const prereqCourse = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: ['prereq-course'], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: ['prereq-course'], passingGrade: 60 }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: registeredStudentEvents, version: 1n })
        .mockResolvedValueOnce({ events: prereqCourse, version: 2n })
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: [], version: 0n }),
    });
    await expect(enrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1' }))
      .rejects.toThrow(PrerequisiteNotSatisfiedError);
  });
});

// --- unenrollStudent command ---
describe('unenrollStudent command', () => {
  const enrolledEvents = [makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
  const openCourseEvents = [
    makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' }),
    makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
  ];

  it('appends StudentDropped when before drop deadline', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n }),
    });
    await unenrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1', unenrolledBy: 's1' });
    expect(store.append).toHaveBeenCalledOnce();
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('StudentDropped');
  });

  it('appends StudentWithdrew when past drop deadline but before withdrawal deadline', async () => {
    const pastDropCourse = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2020-09-15', withdrawalDeadline: '2030-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: pastDropCourse, version: 2n }),
    });
    await unenrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1', unenrolledBy: 's1' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('StudentWithdrew');
  });

  it('throws StudentNotEnrolledError when not enrolled', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n }),
    });
    await expect(unenrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1', unenrolledBy: 's1' }))
      .rejects.toThrow(StudentNotEnrolledError);
  });

  it('throws StudentAlreadyGradedError when graded', async () => {
    const gradedEvents = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 80, gradedBy: 't1', gradedAt: '2024-05-01T00:00:00Z' }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: gradedEvents, version: 2n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 2n }),
    });
    await expect(unenrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1', unenrolledBy: 's1' }))
      .rejects.toThrow(StudentAlreadyGradedError);
  });

  it('throws UnenrollAfterDeadlineError when past withdrawal deadline', async () => {
    const pastDeadlineCourse = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2020-09-15', withdrawalDeadline: '2020-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: pastDeadlineCourse, version: 2n }),
    });
    await expect(unenrollStudent(store, systemClock, { studentId: 's1', courseId: 'c1', unenrolledBy: 's1' }))
      .rejects.toThrow(UnenrollAfterDeadlineError);
  });
});

// --- gradeStudent command ---
describe('gradeStudent command', () => {
  const enrolledEvents = [makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })];
  const openCourseEvents = [
    makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2030-09-15', withdrawalDeadline: '2030-10-15' }),
    makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
    makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
  ];
  const hiredTeacherEvents = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];

  it('throws InvalidGradeError for out-of-range grade', async () => {
    const store = makeMockStore();
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 101, gradedBy: 't1' }))
      .rejects.toThrow(InvalidGradeError);
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: -1, gradedBy: 't1' }))
      .rejects.toThrow(InvalidGradeError);
  });

  it('appends StudentGraded + StudentPassedCourse for passing grade', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 't1' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('StudentGraded');
    expect(appendCall[0]?.[1]?.type).toBe('StudentPassedCourse');
  });

  it('appends StudentGraded + StudentFailedCourse for failing grade', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 45, gradedBy: 't1' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('StudentGraded');
    expect(appendCall[0]?.[1]?.type).toBe('StudentFailedCourse');
  });

  it('throws StudentNotEnrolledError when not enrolled', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: [], version: 0n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 't1' }))
      .rejects.toThrow(StudentNotEnrolledError);
  });

  it('throws StudentAlreadyGradedError when already graded', async () => {
    const gradedEvents = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 80, gradedBy: 't1', gradedAt: '2024-05-01T00:00:00Z' }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: gradedEvents, version: 2n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 't1' }))
      .rejects.toThrow(StudentAlreadyGradedError);
  });

  it('throws WrongTeacherError when not the assigned teacher', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 'wrong-teacher' }))
      .rejects.toThrow(WrongTeacherError);
  });

  it('throws TeacherDismissedError when teacher is dismissed', async () => {
    const dismissedTeacherEvents = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: dismissedTeacherEvents, version: 2n }),
    });
    await expect(gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 75, gradedBy: 't1' }))
      .rejects.toThrow(TeacherDismissedError);
  });

  it('boundary: grade of exactly 60 passes when passingGrade is 60', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 60, gradedBy: 't1' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[1]?.type).toBe('StudentPassedCourse');
  });

  it('boundary: grade of 59 fails when passingGrade is 60', async () => {
    const store = makeMockStore({
      load: vi.fn()
        .mockResolvedValueOnce({ events: enrolledEvents, version: 1n })
        .mockResolvedValueOnce({ events: openCourseEvents, version: 3n })
        .mockResolvedValueOnce({ events: hiredTeacherEvents, version: 1n }),
    });
    await gradeStudent(store, systemClock, { studentId: 's1', courseId: 'c1', grade: 59, gradedBy: 't1' });
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[1]?.type).toBe('StudentFailedCourse');
  });
});
