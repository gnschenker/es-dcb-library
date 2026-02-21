import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { createCourse } from '../../commands/create-course.js';
import { publishCourse } from '../../commands/publish-course.js';
import { closeCourse } from '../../commands/close-course.js';
import { cancelCourse } from '../../commands/cancel-course.js';
import { assignTeacher } from '../../commands/assign-teacher.js';
import { removeTeacher } from '../../commands/remove-teacher.js';
import { enrollStudent } from '../../commands/enroll-student.js';
import { unenrollStudent } from '../../commands/unenroll-student.js';
import { gradeStudent } from '../../commands/grade-student.js';

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

  // GET /courses/:courseId/enrollments — list all enrollment states
  app.get('/courses/:courseId/enrollments', async (request, reply) => {
    const { courseId } = request.params as { courseId: string };
    const { events } = await store.load(courseEnrollmentStream(courseId));

    // Group events by studentId and build per-student enrollment state
    const studentIds = new Set<string>();
    for (const event of events) {
      const studentId = event.payload['studentId'] as string | undefined;
      if (studentId) studentIds.add(studentId);
    }

    const enrollments: { studentId: string; status: string; grade?: number }[] = [];
    for (const studentId of studentIds) {
      const studentEnrollmentEvents = await store.load(enrollmentStream(studentId, courseId));
      const state = reduceEnrollmentForRead(studentEnrollmentEvents.events);
      enrollments.push({ studentId, ...state });
    }

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
