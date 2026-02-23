import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { createCourse } from './create-course.js';
import { publishCourse } from './publish-course.js';
import { closeCourse } from './close-course.js';
import { cancelCourse } from './cancel-course.js';
import { assignTeacher } from '../teachers/assign-teacher.js';
import { removeTeacher } from '../teachers/remove-teacher.js';

function courseStream(courseId: string) {
  return query
    .eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
    .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
    .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
    .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
}

function reduceCourseForRead(events: StoredEvent[]) {
  let state: {
    status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
    courseId?: string;
    title?: string;
    semester?: string;
    creditHours?: number;
    maxStudents?: number;
    prerequisites?: string[];
    passingGrade?: number;
    teacherId?: string | null;
    dropDeadline?: string;
    withdrawalDeadline?: string;
  } = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'CourseCreated') {
      state = {
        status: 'draft',
        courseId: p['courseId'] as string,
        title: p['title'] as string,
        semester: p['semester'] as string,
        creditHours: p['creditHours'] as number,
        maxStudents: p['maxStudents'] as number,
        prerequisites: p['prerequisites'] as string[],
        passingGrade: p['passingGrade'] as number,
        teacherId: null,
        dropDeadline: p['dropDeadline'] as string,
        withdrawalDeadline: p['withdrawalDeadline'] as string,
      };
    } else if (event.type === 'TeacherAssignedToCourse') {
      state = { ...state, teacherId: p['teacherId'] as string };
    } else if (event.type === 'TeacherRemovedFromCourse') {
      state = { ...state, teacherId: null };
    } else if (event.type === 'CoursePublished') {
      state = { ...state, status: 'open' };
    } else if (event.type === 'CourseClosed') {
      state = { ...state, status: 'closed' };
    } else if (event.type === 'CourseCancelled') {
      state = { ...state, status: 'cancelled' };
    }
  }
  return state;
}

export async function registerCourseRoutes(
  app: FastifyInstance,
  store: EventStore,
  clock: Clock,
): Promise<void> {
  // POST /courses — create a course
  app.post('/courses', async (request, reply) => {
    const body = request.body as {
      title: string; semester: string; creditHours: number; maxStudents: number;
      prerequisites?: string[]; passingGrade?: number; dropDeadline: string; withdrawalDeadline: string;
    };
    const result = await createCourse(store, clock, {
      title: body.title,
      semester: body.semester,
      creditHours: body.creditHours,
      maxStudents: body.maxStudents,
      prerequisites: body.prerequisites ?? [],
      dropDeadline: body.dropDeadline,
      withdrawalDeadline: body.withdrawalDeadline,
      ...(body.passingGrade !== undefined ? { passingGrade: body.passingGrade } : {}),
    });
    return reply.status(201).send(result);
  });

  // PUT /courses/:courseId/teacher — assign teacher
  app.put('/courses/:courseId/teacher', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    const body = request.body as { teacherId: string };
    await assignTeacher(store, clock, { courseId, teacherId: body.teacherId });
    return reply.status(201).send({});
  });

  // DELETE /courses/:courseId/teacher — remove teacher
  app.delete('/courses/:courseId/teacher', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    await removeTeacher(store, clock, { courseId });
    return reply.status(200).send({});
  });

  // POST /courses/:courseId/publish
  app.post('/courses/:courseId/publish', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    await publishCourse(store, clock, { courseId });
    return reply.status(201).send({});
  });

  // POST /courses/:courseId/close
  app.post('/courses/:courseId/close', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    await closeCourse(store, clock, { courseId });
    return reply.status(201).send({});
  });

  // POST /courses/:courseId/cancel
  app.post('/courses/:courseId/cancel', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    const body = request.body as { reason: string };
    await cancelCourse(store, clock, { courseId, reason: body.reason });
    return reply.status(201).send({});
  });

  // GET /courses/:courseId — read course state
  app.get('/courses/:courseId', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    const { events } = await store.load(courseStream(courseId));
    const state = reduceCourseForRead(events);
    if (state.status === 'none') {
      return reply.status(404).send({ error: 'CourseNotFoundError', message: `Course '${courseId}' not found` });
    }
    return reply.status(200).send(state);
  });
}
