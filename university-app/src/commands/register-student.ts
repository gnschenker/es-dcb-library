import type { EventStore, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';
import { studentIdFromEmail } from '../domain/ids.js';
import { StudentAlreadyRegisteredError } from '../domain/errors.js';
import type { StudentRegisteredPayload } from '../domain/events.js';

// Private to this slice
function studentStream(studentId: string) {
  return query
    .eventsOfType('StudentRegistered').where.key('studentId').equals(studentId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
}

export interface RegisterStudentInput {
  name: string;
  email: string;
  dateOfBirth: string;
}

export async function registerStudent(
  store: EventStore,
  clock: Clock,
  input: RegisterStudentInput,
): Promise<{ studentId: string }> {
  const studentId = studentIdFromEmail(input.email);
  const { version } = await store.load(studentStream(studentId));

  if (version > 0n) {
    throw new StudentAlreadyRegisteredError(
      `Student with email '${input.email}' is already registered`,
    );
  }

  const payload: StudentRegisteredPayload = {
    studentId,
    name: input.name,
    email: input.email,
    dateOfBirth: input.dateOfBirth,
    registeredAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'StudentRegistered', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: studentStream(studentId), expectedVersion: 0n },
  );

  return { studentId };
}
