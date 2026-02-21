import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore, clearEvents } from './helpers.js';
import { systemClock } from '../../src/domain/clock.js';
import { studentIdFromEmail } from '../../src/domain/ids.js';
import { registerStudent } from '../../src/commands/register-student.js';
import { StudentAlreadyRegisteredError } from '../../src/domain/errors.js';

const STUDENT = { name: 'Alice', email: 'alice@student.edu', dateOfBirth: '2000-01-01' };

beforeEach(clearEvents);

describe('RegisterStudent', () => {
  it('happy path — StudentRegistered; returned studentId matches deterministic ID', async () => {
    const store = createTestStore();
    const { studentId } = await registerStudent(store, systemClock, STUDENT);
    expect(studentId).toBe(studentIdFromEmail(STUDENT.email));
    await store.close();
  });

  it('same email twice → StudentAlreadyRegisteredError', async () => {
    const store = createTestStore();
    try {
      await registerStudent(store, systemClock, STUDENT);
      await expect(registerStudent(store, systemClock, STUDENT)).rejects.toThrow(StudentAlreadyRegisteredError);
    } finally {
      await store.close();
    }
  });

  it('email is case-insensitive for studentId derivation', async () => {
    const store = createTestStore();
    const { studentId } = await registerStudent(store, systemClock, { ...STUDENT, email: 'Alice@Student.EDU' });
    expect(studentId).toBe(studentIdFromEmail('alice@student.edu'));
    await store.close();
  });
});
