import { describe, it, expect } from 'vitest';
import type { StoredEvent } from 'es-dcb-library';
import {
  reduceTeacher,
  reduceCourse,
  reduceEnrollment,
  reduceStudentCompletedCourses,
  reduceEnrollmentCount,
} from '../../src/domain/reducers.js';

let pos = 1n;
function makeEvent(type: string, payload: Record<string, unknown>): StoredEvent {
  return {
    globalPosition: pos++,
    eventId: `evt-${String(pos)}`,
    type,
    payload,
    metadata: null,
    occurredAt: new Date('2024-01-01T00:00:00Z'),
  };
}

describe('reduceTeacher', () => {
  it('returns none for empty events', () => {
    expect(reduceTeacher([])).toEqual({ status: 'none' });
  });

  it('returns hired state after TeacherHired', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];
    const state = reduceTeacher(events);
    expect(state.status).toBe('hired');
    expect(state.name).toBe('Dr. Smith');
    expect(state.department).toBe('CS');
  });

  it('captures email from TeacherHired', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' })];
    expect(reduceTeacher(events).email).toBe('smith@uni.edu');
  });

  it('returns dismissed after hired+dismissed', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'budget cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
    ];
    const state = reduceTeacher(events);
    expect(state.status).toBe('dismissed');
    expect(state.name).toBe('Dr. Smith');
  });

  it('can re-hire after dismissal', () => {
    const events = [
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }),
      makeEvent('TeacherDismissed', { teacherId: 't1', reason: 'budget cuts', dismissedAt: '2024-02-01T00:00:00Z' }),
      makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'Math', hiredAt: '2024-03-01T00:00:00Z' }),
    ];
    const state = reduceTeacher(events);
    expect(state.status).toBe('hired');
    expect(state.department).toBe('Math');
  });

  it('ignores unknown event types', () => {
    const events = [makeEvent('TeacherHired', { teacherId: 't1', name: 'Dr. Smith', email: 'smith@uni.edu', department: 'CS', hiredAt: '2024-01-01T00:00:00Z' }), makeEvent('Unknown', {})];
    expect(reduceTeacher(events).status).toBe('hired');
  });
});

describe('reduceCourse', () => {
  it('returns none for empty events', () => {
    expect(reduceCourse([])).toEqual({ status: 'none' });
  });

  it('returns draft after CourseCreated', () => {
    const events = [makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })];
    const state = reduceCourse(events);
    expect(state.status).toBe('draft');
    expect(state.title).toBe('Intro CS');
    expect(state.creditHours).toBe(3);
    expect(state.teacherId).toBeNull();
  });

  it('captures all CourseCreated fields', () => {
    const state = reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' })]);
    expect(state.semester).toBe('Fall 2024');
    expect(state.maxStudents).toBe(30);
    expect(state.passingGrade).toBe(60);
    expect(state.dropDeadline).toBe('2024-09-15');
    expect(state.withdrawalDeadline).toBe('2024-10-15');
  });

  it('sets teacherId after TeacherAssignedToCourse', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' })]).teacherId).toBe('t1');
  });

  it('nulls teacherId after TeacherRemovedFromCourse', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }), makeEvent('TeacherRemovedFromCourse', { courseId: 'c1', teacherId: 't1', removedAt: '2024-01-03T00:00:00Z' })]).teacherId).toBeNull();
  });

  it('returns open after CoursePublished', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }), makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 })]).status).toBe('open');
  });

  it('returns closed after CourseClosed', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }), makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 }), makeEvent('CourseClosed', { courseId: 'c1', closedAt: '2024-12-01T00:00:00Z' })]).status).toBe('closed');
  });

  it('returns cancelled after CourseCancelled', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('CourseCancelled', { courseId: 'c1', reason: 'low enrollment', cancelledAt: '2024-02-01T00:00:00Z' })]).status).toBe('cancelled');
  });

  it('CoursePublished preserves deadlines', () => {
    const state = reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }), makeEvent('CoursePublished', { courseId: 'c1', teacherId: 't1', maxStudents: 30, creditHours: 3, prerequisites: [], passingGrade: 60 })]);
    expect(state.dropDeadline).toBe('2024-09-15');
    expect(state.withdrawalDeadline).toBe('2024-10-15');
  });

  it('last TeacherAssignedToCourse wins', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't1', assignedAt: '2024-01-02T00:00:00Z' }), makeEvent('TeacherRemovedFromCourse', { courseId: 'c1', teacherId: 't1', removedAt: '2024-01-03T00:00:00Z' }), makeEvent('TeacherAssignedToCourse', { courseId: 'c1', teacherId: 't2', assignedAt: '2024-01-04T00:00:00Z' })]).teacherId).toBe('t2');
  });

  it('ignores unknown event types', () => {
    expect(reduceCourse([makeEvent('CourseCreated', { courseId: 'c1', title: 'Intro CS', semester: 'Fall 2024', creditHours: 3, maxStudents: 30, prerequisites: [], passingGrade: 60, dropDeadline: '2024-09-15', withdrawalDeadline: '2024-10-15' }), makeEvent('Unknown', {})]).status).toBe('draft');
  });
});

describe('reduceEnrollment', () => {
  it('returns none for empty events', () => {
    expect(reduceEnrollment([])).toEqual({ status: 'none' });
  });

  it('returns enrolled', () => {
    expect(reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' })]).status).toBe('enrolled');
  });

  it('returns dropped', () => {
    expect(reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-20T00:00:00Z', droppedBy: 's1' })]).status).toBe('dropped');
  });

  it('returns withdrew', () => {
    expect(reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentWithdrew', { studentId: 's1', courseId: 'c1', withdrewAt: '2024-02-01T00:00:00Z', withdrewBy: 's1' })]).status).toBe('withdrew');
  });

  it('returns graded with grade value', () => {
    const state = reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' })]);
    expect(state.status).toBe('graded');
    expect(state.grade).toBe(85);
  });

  it('returns passed', () => {
    expect(reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }), makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' })]).status).toBe('passed');
  });

  it('returns failed', () => {
    expect(reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 45, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }), makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'Fall 2024' })]).status).toBe('failed');
  });

  it('passed preserves grade', () => {
    const state = reduceEnrollment([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 88, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }), makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 88, creditHours: 3, semester: 'Fall 2024' })]);
    expect(state.status).toBe('passed');
    expect(state.grade).toBe(88);
  });
});

describe('reduceStudentCompletedCourses', () => {
  it('returns empty map for no events', () => {
    expect(reduceStudentCompletedCourses([])).toEqual(new Map());
  });

  it('records single pass', () => {
    expect(reduceStudentCompletedCourses([makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' })]).get('c1')).toBe('passed');
  });

  it('records single fail', () => {
    expect(reduceStudentCompletedCourses([makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c2', finalGrade: 45, creditHours: 3, semester: 'Fall 2024' })]).get('c2')).toBe('failed');
  });

  it('later event wins - fail then retake pass', () => {
    const events = [makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'Fall 2023' }), makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 75, creditHours: 3, semester: 'Spring 2024' })];
    expect(reduceStudentCompletedCourses(events).get('c1')).toBe('passed');
  });

  it('later event wins - pass then retake fail', () => {
    const events = [makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 75, creditHours: 3, semester: 'Fall 2023' }), makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 45, creditHours: 3, semester: 'Spring 2024' })];
    expect(reduceStudentCompletedCourses(events).get('c1')).toBe('failed');
  });

  it('handles multiple distinct courses', () => {
    const map = reduceStudentCompletedCourses([makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' }), makeEvent('StudentFailedCourse', { studentId: 's1', courseId: 'c2', finalGrade: 45, creditHours: 3, semester: 'Fall 2024' })]);
    expect(map.get('c1')).toBe('passed');
    expect(map.get('c2')).toBe('failed');
  });

  it('ignores non-outcome events', () => {
    expect(reduceStudentCompletedCourses([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-10T00:00:00Z' }), makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' })]).size).toBe(0);
  });

  it('map has correct size with two courses', () => {
    expect(reduceStudentCompletedCourses([makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' }), makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c2', finalGrade: 90, creditHours: 3, semester: 'Fall 2024' })]).size).toBe(2);
  });
});

describe('reduceEnrollmentCount', () => {
  it('returns 0 for empty events', () => {
    expect(reduceEnrollmentCount([])).toBe(0);
  });

  it('counts two enrolled students', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' })])).toBe(2);
  });

  it('enrolled then dropped = 0', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' })])).toBe(0);
  });

  it('enrolled then withdrew = 0', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentWithdrew', { studentId: 's2', courseId: 'c1', withdrewAt: '2024-02-01T00:00:00Z', withdrewBy: 's2' })])).toBe(0);
  });

  it('two enrolled one dropped = 1', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }), makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' })])).toBe(1);
  });

  it('count never goes below 0', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' })])).toBe(0);
  });

  it('three enrolled two removed = 1', () => {
    const events = [
      makeEvent('StudentEnrolled', { studentId: 's1', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentEnrolled', { studentId: 's2', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentEnrolled', { studentId: 's3', courseId: 'c1', enrolledAt: '2024-01-01T00:00:00Z' }),
      makeEvent('StudentDropped', { studentId: 's1', courseId: 'c1', droppedAt: '2024-01-10T00:00:00Z', droppedBy: 's1' }),
      makeEvent('StudentWithdrew', { studentId: 's2', courseId: 'c1', withdrewAt: '2024-02-01T00:00:00Z', withdrewBy: 's2' }),
    ];
    expect(reduceEnrollmentCount(events)).toBe(1);
  });

  it('ignores non-enrollment events', () => {
    expect(reduceEnrollmentCount([makeEvent('StudentGraded', { studentId: 's1', courseId: 'c1', grade: 85, gradedBy: 't1', gradedAt: '2024-12-01T00:00:00Z' }), makeEvent('StudentPassedCourse', { studentId: 's1', courseId: 'c1', finalGrade: 85, creditHours: 3, semester: 'Fall 2024' })])).toBe(0);
  });
});
