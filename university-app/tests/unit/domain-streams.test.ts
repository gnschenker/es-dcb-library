import { describe, it, expect } from 'vitest';
import {
  teacherStream,
  courseStream,
  courseEnrollmentStream,
  studentStream,
  enrollmentStream,
} from '../../src/domain/streams.js';

describe('stream definitions', () => {
  it('teacherStream has 2 clauses', () => {
    const stream = teacherStream('t1');
    expect(stream._clauses.length).toBe(2);
  });

  it('teacherStream clauses have correct types', () => {
    const stream = teacherStream('t1');
    expect(stream._clauses[0]?.type).toBe('TeacherHired');
    expect(stream._clauses[1]?.type).toBe('TeacherDismissed');
  });

  it('teacherStream clauses filter on teacherId', () => {
    const stream = teacherStream('t99');
    for (const clause of stream._clauses) {
      expect(clause.filter).not.toBeNull();
      expect(clause.filter).toMatchObject({ kind: 'attr', key: 'teacherId', value: 't99' });
    }
  });

  it('courseStream has 6 clauses', () => {
    expect(courseStream('c1')._clauses.length).toBe(6);
  });

  it('courseStream clauses have correct types', () => {
    const stream = courseStream('c1');
    const types = stream._clauses.map((c) => c.type);
    expect(types).toEqual([
      'CourseCreated',
      'CoursePublished',
      'CourseClosed',
      'CourseCancelled',
      'TeacherAssignedToCourse',
      'TeacherRemovedFromCourse',
    ]);
  });

  it('courseStream clauses filter on courseId', () => {
    const stream = courseStream('c42');
    for (const clause of stream._clauses) {
      expect(clause.filter).not.toBeNull();
      expect(clause.filter).toMatchObject({ kind: 'attr', key: 'courseId', value: 'c42' });
    }
  });

  it('courseEnrollmentStream has 3 clauses', () => {
    expect(courseEnrollmentStream('c1')._clauses.length).toBe(3);
  });

  it('courseEnrollmentStream clauses have correct types', () => {
    const stream = courseEnrollmentStream('c1');
    const types = stream._clauses.map((c) => c.type);
    expect(types).toEqual(['StudentEnrolled', 'StudentDropped', 'StudentWithdrew']);
  });

  it('studentStream has 3 clauses', () => {
    expect(studentStream('s1')._clauses.length).toBe(3);
  });

  it('studentStream clauses have correct types', () => {
    const stream = studentStream('s1');
    const types = stream._clauses.map((c) => c.type);
    expect(types).toEqual(['StudentRegistered', 'StudentPassedCourse', 'StudentFailedCourse']);
  });

  it('studentStream clauses filter on studentId', () => {
    const stream = studentStream('s7');
    for (const clause of stream._clauses) {
      expect(clause.filter).not.toBeNull();
      expect(clause.filter).toMatchObject({ kind: 'attr', key: 'studentId', value: 's7' });
    }
  });

  it('enrollmentStream has 6 clauses', () => {
    expect(enrollmentStream('s1', 'c1')._clauses.length).toBe(6);
  });

  it('enrollmentStream clauses have correct types', () => {
    const stream = enrollmentStream('s1', 'c1');
    const types = stream._clauses.map((c) => c.type);
    expect(types).toEqual([
      'StudentEnrolled',
      'StudentDropped',
      'StudentWithdrew',
      'StudentGraded',
      'StudentPassedCourse',
      'StudentFailedCourse',
    ]);
  });

  it('enrollmentStream clauses have AND filter for both studentId and courseId', () => {
    const stream = enrollmentStream('s5', 'c10');
    for (const clause of stream._clauses) {
      expect(clause.filter).not.toBeNull();
      expect(clause.filter?.kind).toBe('and');
      if (clause.filter?.kind === 'and') {
        const filters = clause.filter.filters;
        expect(filters).toContainEqual({ kind: 'attr', key: 'studentId', value: 's5' });
        expect(filters).toContainEqual({ kind: 'attr', key: 'courseId', value: 'c10' });
      }
    }
  });

  it('different teacherIds produce different stream clause filters', () => {
    const s1 = teacherStream('teacher-A');
    const s2 = teacherStream('teacher-B');
    expect(s1._clauses[0]?.filter).not.toEqual(s2._clauses[0]?.filter);
  });
});
