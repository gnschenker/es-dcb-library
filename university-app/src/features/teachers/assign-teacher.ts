import type { EventStore, StoredEvent, NewEvent } from 'es-dcb-library';
import { query, queryItem, combineQueries } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import {
  CourseNotFoundError,
  CourseNotInDraftError,
  TeacherNotFoundError,
  TeacherDismissedError,
} from '../../domain/errors.js';
import type { TeacherAssignedToCoursePayload } from '../../domain/events.js';

// Private to this slice
function courseStream(courseId: string) {
  return query([
    { types: ['CourseCreated'], tags: [`course:${courseId}`] },
    { types: ['CoursePublished'], tags: [`course:${courseId}`] },
    { types: ['CourseClosed'], tags: [`course:${courseId}`] },
    { types: ['CourseCancelled'], tags: [`course:${courseId}`] },
    { types: ['TeacherAssignedToCourse'], tags: [`course:${courseId}`] },
    { types: ['TeacherRemovedFromCourse'], tags: [`course:${courseId}`] },
  ]);
}

function teacherStream(teacherId: string) {
  return query([
    { types: ['TeacherHired'], tags: [`teacher:${teacherId}`] },
    { types: ['TeacherDismissed'], tags: [`teacher:${teacherId}`] },
  ]);
}

// Exported reducers (for unit tests)
export type CourseAssignState = { status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled' };

export function reduceCourseForAssign(events: StoredEvent[]): CourseAssignState {
  let status: CourseAssignState['status'] = 'none';
  for (const event of events) {
    if (event.type === 'CourseCreated') status = 'draft';
    else if (event.type === 'CoursePublished') status = 'open';
    else if (event.type === 'CourseClosed') status = 'closed';
    else if (event.type === 'CourseCancelled') status = 'cancelled';
  }
  return { status };
}

export type TeacherAssignState = { status: 'none' | 'hired' | 'dismissed' };

export function reduceTeacherForAssign(events: StoredEvent[]): TeacherAssignState {
  let status: TeacherAssignState['status'] = 'none';
  for (const event of events) {
    if (event.type === 'TeacherHired') status = 'hired';
    else if (event.type === 'TeacherDismissed') status = 'dismissed';
  }
  return { status };
}

export interface AssignTeacherInput { courseId: string; teacherId: string; }

export async function assignTeacher(
  store: EventStore,
  clock: Clock,
  input: AssignTeacherInput,
): Promise<void> {
  const allStreams = combineQueries(
    courseStream(input.courseId),
    teacherStream(input.teacherId),
  );
  
  const { events, position } = await store.load(allStreams);
  
  const courseEvents = events.filter(e => e.tags.includes(`course:${input.courseId}`));
  const teacherEvents = events.filter(e => e.tags.includes(`teacher:${input.teacherId}`));

  const courseState = reduceCourseForAssign(courseEvents);
  if (courseState.status === 'none') {
    throw new CourseNotFoundError(`Course '${input.courseId}' not found`);
  }
  if (courseState.status !== 'draft' && courseState.status !== 'open') {
    throw new CourseNotInDraftError(
      `Course '${input.courseId}' is not in an active state (current: ${courseState.status})`,
    );
  }

  const teacherState = reduceTeacherForAssign(teacherEvents);
  if (teacherState.status === 'none') {
    throw new TeacherNotFoundError(`Teacher '${input.teacherId}' not found`);
  }
  if (teacherState.status === 'dismissed') {
    throw new TeacherDismissedError(`Teacher '${input.teacherId}' is dismissed`);
  }

  const data: TeacherAssignedToCoursePayload = {
    courseId: input.courseId,
    teacherId: input.teacherId,
    assignedAt: clock.now().toISOString(),
  };

  await store.append(
    [{ type: 'TeacherAssignedToCourse', data: data as unknown as Record<string, unknown>} as NewEvent],
    { failIfEventsMatch: allStreams, after: position },
  );
}
