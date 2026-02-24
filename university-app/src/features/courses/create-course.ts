import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { newCourseId } from '../../domain/ids.js';
import {
  InvalidCreditHoursError,
  InvalidMaxStudentsError,
  InvalidPassingGradeError,
  PrerequisiteNotFoundError,
} from '../../domain/errors.js';
import type { CourseCreatedPayload } from '../../domain/events.js';

// Private to this slice
function courseStream(courseId: string) {
  return query
    .eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
    .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
    .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
    .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
}

export interface CreateCourseInput {
  title: string;
  semester: string;
  creditHours: number;
  maxStudents: number;
  prerequisites?: string[];
  passingGrade?: number;
  dropDeadline: string;
  withdrawalDeadline: string;
}

export async function createCourse(
  store: EventStore,
  clock: Clock,
  input: CreateCourseInput,
): Promise<{ courseId: string }> {
  // Validate inputs
  if (input.creditHours < 1 || input.creditHours > 6) {
    throw new InvalidCreditHoursError(
      `creditHours must be between 1 and 6, got ${input.creditHours}`,
    );
  }
  if (input.maxStudents < 1) {
    throw new InvalidMaxStudentsError(`maxStudents must be at least 1, got ${input.maxStudents}`);
  }
  const passingGrade = input.passingGrade ?? 60;
  if (passingGrade < 0 || passingGrade > 100) {
    throw new InvalidPassingGradeError(
      `passingGrade must be between 0 and 100, got ${passingGrade}`,
    );
  }

  const prerequisites = input.prerequisites ?? [];

  // Validate each prerequisite course exists
  for (const prereqId of prerequisites) {
    const { events } = await store.load(courseStream(prereqId));
    if (events.length === 0) {
      throw new PrerequisiteNotFoundError(`Prerequisite course '${prereqId}' does not exist`);
    }
  }

  const courseId = newCourseId();
  const payload: CourseCreatedPayload = {
    courseId,
    title: input.title,
    semester: input.semester,
    creditHours: input.creditHours,
    maxStudents: input.maxStudents,
    prerequisites,
    passingGrade,
    dropDeadline: input.dropDeadline,
    withdrawalDeadline: input.withdrawalDeadline,
  };

  await store.append(
    [{ type: 'CourseCreated', payload: payload as unknown as Record<string, unknown> } as NewEvent],
    { query: courseStream(courseId), expectedVersion: 0n },
  );

  return { courseId };
}
