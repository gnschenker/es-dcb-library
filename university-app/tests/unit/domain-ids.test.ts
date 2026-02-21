import { describe, it, expect } from 'vitest';
import { teacherIdFromEmail, studentIdFromEmail, newCourseId } from '../../src/domain/ids.js';

describe('teacherIdFromEmail', () => {
  it('is case-insensitive', () => {
    expect(teacherIdFromEmail('Alice@Example.COM')).toBe(teacherIdFromEmail('alice@example.com'));
  });

  it('trims whitespace', () => {
    expect(teacherIdFromEmail('  alice@example.com  ')).toBe(teacherIdFromEmail('alice@example.com'));
  });

  it('is deterministic', () => {
    const id1 = teacherIdFromEmail('test@example.com');
    const id2 = teacherIdFromEmail('test@example.com');
    expect(id1).toBe(id2);
  });

  it('differs from studentIdFromEmail for same email', () => {
    expect(teacherIdFromEmail('a@b.com')).not.toBe(studentIdFromEmail('a@b.com'));
  });
});

describe('studentIdFromEmail', () => {
  it('is case-insensitive', () => {
    expect(studentIdFromEmail('Bob@SCHOOL.EDU')).toBe(studentIdFromEmail('bob@school.edu'));
  });

  it('is deterministic', () => {
    const id1 = studentIdFromEmail('student@uni.edu');
    const id2 = studentIdFromEmail('student@uni.edu');
    expect(id1).toBe(id2);
  });
});

describe('newCourseId', () => {
  it('returns a valid UUID format', () => {
    const id = newCourseId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('returns different values on each call', () => {
    expect(newCourseId()).not.toBe(newCourseId());
  });
});
