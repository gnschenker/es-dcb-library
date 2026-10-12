import type { EventStore, NewEvent } from 'es-dcb-library';
import { query, queryItem } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { studentIdFromEmail } from '../../domain/ids.js';
import { StudentAlreadyRegisteredError } from '../../domain/errors.js';
import type { StudentRegisteredPayload } from '../../domain/events.js';

// Private to this slice
function studentStream(studentId: string) {
  return query([
    { types: ['StudentRegistered'], tags: [`student:${studentId}`] },
    { types: ['StudentPassedCourse'], tags: [`student:${studentId}`] },
    { types: ['StudentFailedCourse'], tags: [`student:${studentId}`] },
  ]);

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

  const data: StudentRegisteredPayload = {
    studentId,
    name: input.name,
    email: input.email,
    dateOfBirth: input.dateOfBirth,
    registeredAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'StudentRegistered', data: data as unknown as Record<string, unknown>} as NewEvent],
    { failIfEventsMatch: studentStream(studentId), after: 0n },
  );

  return { studentId };
}
