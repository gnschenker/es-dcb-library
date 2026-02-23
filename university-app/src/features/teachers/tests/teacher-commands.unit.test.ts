import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StoredEvent, EventStore } from 'es-dcb-library';
import { reduceTeacher as reduceTeacherForHire } from '../hire-teacher.js';
import { hireTeacher } from '../hire-teacher.js';
import {
  reduceTeacher as reduceTeacherForDismiss,
  reduceCourseForDismiss,
} from '../dismiss-teacher.js';
import { dismissTeacher } from '../dismiss-teacher.js';
import {
  TeacherAlreadyHiredError,
  TeacherNotFoundError,
  TeacherDismissedError,
  TeacherAssignedToOpenCourseError,
} from '../../../domain/errors.js';
import { systemClock } from '../../../domain/clock.js';

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

// --- hire-teacher reducer ---
describe('reduceTeacher (hire-teacher slice)', () => {
  it('returns none for empty events', () => {
    expect(reduceTeacherForHire([])).toEqual({ status: 'none' });
  });

  it('returns hired after TeacherHired', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];
    const state = reduceTeacherForHire(events);
    expect(state.status).toBe('hired');
    expect(state.name).toBe('Dr. Smith');
    expect(state.department).toBe('CS');
  });

  it('returns dismissed after hired+dismissed', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    const state = reduceTeacherForHire(events);
    expect(state.status).toBe('dismissed');
    expect(state.name).toBe('Dr. Smith'); // preserved after dismissal
  });

  it('can be re-hired after dismissal', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'Math', hiredAt: '2024-03-01T00:00:00Z' }),
    ];
    const state = reduceTeacherForHire(events);
    expect(state.status).toBe('hired');
    expect(state.department).toBe('Math');
  });
});

// --- hireTeacher command ---
describe('hireTeacher command', () => {
  it('appends TeacherHired event on success', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    });
    const result = await hireTeacher(store, systemClock, { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' });
    expect(result.teacherId).toBeTypeOf('string');
    expect(store.append).toHaveBeenCalledOnce();
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('TeacherHired');
  });

  it('throws TeacherAlreadyHiredError when already hired', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({
        events: [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })],
        version: 1n,
      }),
    });
    await expect(hireTeacher(store, systemClock, { name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS' }))
      .rejects.toThrow(TeacherAlreadyHiredError);
  });

  it('uses same teacherId for same email (deterministic)', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    });
    const r1 = await hireTeacher(store, systemClock, { name: 'A', email: 'same@email.com', department: 'CS' });
    const store2 = makeMockStore({
      load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    });
    const r2 = await hireTeacher(store2, systemClock, { name: 'B', email: 'SAME@email.com', department: 'Math' });
    expect(r1.teacherId).toBe(r2.teacherId);
  });
});

// --- dismiss-teacher reducer ---
describe('reduceTeacher (dismiss-teacher slice)', () => {
  it('returns none for empty events', () => {
    expect(reduceTeacherForDismiss([])).toEqual({ status: 'none' });
  });

  it('tracks hired status', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];
    expect(reduceTeacherForDismiss(events).status).toBe('hired');
  });

  it('tracks dismissed status', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    expect(reduceTeacherForDismiss(events).status).toBe('dismissed');
  });
});

describe('reduceCourseForDismiss', () => {
  it('returns none for empty events', () => {
    expect(reduceCourseForDismiss([])).toEqual({ status: 'none' });
  });

  it('tracks teacher assignment', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
    ];
    expect(reduceCourseForDismiss(events).teacherId).toBe('t1');
  });

  it('teacher reassignment clears previous (null after remove)', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }),
      makeEvent('TeacherRemovedFromCourse', { courseId: 'c1', teacherId: 't1', removedAt: '2024-01-03T00:00:00Z' }),
    ];
    expect(reduceCourseForDismiss(events).teacherId).toBeNull();
  });

  it('tracks open status', () => {
    const events = [
      makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro', semester: 'F24', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }),
      makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }),
    ];
    expect(reduceCourseForDismiss(events).status).toBe('open');
  });
});

// --- dismissTeacher command ---
describe('dismissTeacher command', () => {
  it('throws TeacherNotFoundError when teacher does not exist', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({ events: [], version: 0n }),
    });
    await expect(dismissTeacher(store, systemClock, { teacherId: 't1', reason: 'cuts' }))
      .rejects.toThrow(TeacherNotFoundError);
  });

  it('throws TeacherDismissedError when already dismissed', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({
        events: [
          makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
          makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'prior', dismissedAt: '2024-02-01T00:00:00Z' }),
        ],
        version: 2n,
      }),
    });
    await expect(dismissTeacher(store, systemClock, { teacherId: 't1', reason: 'again' }))
      .rejects.toThrow(TeacherDismissedError);
  });

  it('appends TeacherDismissed when no courses assigned', async () => {
    const store = makeMockStore({
      load: vi.fn().mockResolvedValue({
        events: [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 's@u.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })],
        version: 1n,
      }),
      stream: vi.fn().mockReturnValue((async function* () {})()),
    });
    await dismissTeacher(store, systemClock, { teacherId: 't1', reason: 'cuts' });
    expect(store.append).toHaveBeenCalledOnce();
    const appendCall = vi.mocked(store.append).mock.calls[0] as unknown as [Array<{ type: string }>];
    expect(appendCall[0]?.[0]?.type).toBe('TeacherDismissed');
  });
});
