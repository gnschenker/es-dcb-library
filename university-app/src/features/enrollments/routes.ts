import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { enrollStudent } from './enroll-student.js';
import { unenrollStudent } from './unenroll-student.js';
import { gradeStudent } from './grade-student.js';

function courseStream(courseId: string) {
  return query
    .eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
    .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
    .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
    .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
}

function courseEnrollmentStream(courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('courseId').equals(courseId)
    .eventsOfType('StudentGraded').where.key('courseId').equals(courseId)
    .eventsOfType('StudentPassedCourse').where.key('courseId').equals(courseId)
    .eventsOfType('StudentFailedCourse').where.key('courseId').equals(courseId);
}

function enrollmentStream(studentId: string, courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
}

function reduceCourseStatus(events: StoredEvent[]) {
  let state: {
    status: 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
  } = { status: 'none' };
  for (const event of events) {
    if (event.type === 'CourseCreated') {
      state = { status: 'draft' };
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

function reduceEnrollmentForRead(events: StoredEvent[]): {
  status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
  grade?: number;
} {
  let status: 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed' = 'none';
  let grade: number | undefined;
  for (const event of events) {
    if (event.type === 'StudentEnrolled') { status = 'enrolled'; }
    else if (event.type === 'StudentDropped') { status = 'dropped'; }
    else if (event.type === 'StudentWithdrew') { status = 'withdrew'; }
    else if (event.type === 'StudentGraded') { status = 'graded'; grade = event.payload['grade'] as number; }
    else if (event.type === 'StudentPassedCourse') { status = 'passed'; }
    else if (event.type === 'StudentFailedCourse') { status = 'failed'; }
  }
  return grade !== undefined ? { status, grade } : { status };
}

export async function registerEnrollmentRoutes(
  app: FastifyInstance,
  store: EventStore,
  clock: Clock,
): Promise<void> {
  // GET /courses/:courseId/enrollments — list all enrollment states
  app.get('/courses/:courseId/enrollments', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };

    // First verify the course exists
    const { events: courseEvents } = await store.load(courseStream(courseId));
    const courseState = reduceCourseStatus(courseEvents);
    if (courseState.status === 'none') {
      return reply.status(404).send({ error: 'CourseNotFoundError', message: `Course '${courseId}' not found` });
    }

    const { events } = await store.load(courseEnrollmentStream(courseId));

    // Group events by studentId
    const studentIds = new Set<string>();
    for (const event of events) {
      const studentId = event.payload['studentId'] as string | undefined;
      if (studentId) studentIds.add(studentId);
    }

    // Parallelize per-student enrollment stream loads
    const enrollments = await Promise.all(
      Array.from(studentIds).map(async (studentId) => {
        const { events: studentEnrollmentEvents } = await store.load(enrollmentStream(studentId, courseId));
        const state = reduceEnrollmentForRead(studentEnrollmentEvents);
        return { studentId, ...state };
      }),
    );

    return reply.status(200).send(enrollments);
  });

  // POST /courses/:courseId/enrollments — enroll a student
  app.post('/courses/:courseId/enrollments', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    const body = request.body as { studentId: string };
    await enrollStudent(store, clock, { studentId: body.studentId, courseId });
    return reply.status(201).send({});
  });

  // POST /courses/:courseId/enrollments/:studentId/unenroll — unenroll a student
  app.post('/courses/:courseId/enrollments/:studentId/unenroll', async (request, reply) => {
    const { courseId, studentId } = request.params as { courseId: string; studentId: string };
    const body = request.body as { reason?: string; unenrolledBy?: string };
    await unenrollStudent(store, clock, {
      studentId,
      courseId,
      reason: body.reason ?? '',
      unenrolledBy: body.unenrolledBy ?? studentId,
    });
    return reply.status(201).send({});
  });

  // POST /courses/:courseId/enrollments/:studentId/grade — grade a student
  app.post('/courses/:courseId/enrollments/:studentId/grade', async (request, reply) => {
    const { courseId, studentId } = request.params as { courseId: string; studentId: string };
    const body = request.body as { grade: number; gradedBy: string };
    await gradeStudent(store, clock, { studentId, courseId, grade: body.grade, gradedBy: body.gradedBy });
    return reply.status(201).send({});
  });
}
