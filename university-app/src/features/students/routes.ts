import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { registerStudent } from './register-student.js';

function studentStream(studentId: string) {
  return query
    .eventsOfType('StudentRegistered').where.key('studentId').equals(studentId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
}

function studentEnrollmentHistoryStream(studentId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
}

interface StudentReadState {
  registered: boolean;
  studentId: string;
  name: string;
  email: string;
  dateOfBirth: string;
  registeredAt: string;
}

function reduceStudentForRead(events: StoredEvent[]): StudentReadState | null {
  for (const event of events) {
    if (event.type === 'StudentRegistered') {
      const p = event.payload;
      return {
        registered: true,
        studentId: p['studentId'] as string,
        name: p['name'] as string,
        email: p['email'] as string,
        dateOfBirth: p['dateOfBirth'] as string,
        registeredAt: p['registeredAt'] as string,
      };
    }
  }
  return null;
}

function reduceCourseHistory(events: StoredEvent[]): Map<string, {
  status: 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
  grade?: number;
}> {
  const courses = new Map<string, {
    status: 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
    grade?: number;
  }>();
  for (const event of events) {
    const courseId = event.payload['courseId'] as string | undefined;
    if (!courseId) continue;
    const existing = courses.get(courseId);
    if (event.type === 'StudentEnrolled') {
      courses.set(courseId, { status: 'enrolled' });
    } else if (event.type === 'StudentDropped') {
      courses.set(courseId, { status: 'dropped' });
    } else if (event.type === 'StudentWithdrew') {
      courses.set(courseId, { status: 'withdrew' });
    } else if (event.type === 'StudentGraded') {
      courses.set(courseId, { status: 'graded', grade: event.payload['grade'] as number });
    } else if (event.type === 'StudentPassedCourse') {
      const grade = existing?.grade;
      courses.set(courseId, grade !== undefined ? { status: 'passed', grade } : { status: 'passed' });
    } else if (event.type === 'StudentFailedCourse') {
      const grade = existing?.grade;
      courses.set(courseId, grade !== undefined ? { status: 'failed', grade } : { status: 'failed' });
    }
  }
  return courses;
}

export async function registerStudentRoutes(
  app: FastifyInstance,
  store: EventStore,
  clock: Clock,
): Promise<void> {
  // POST /students — register a student
  app.post('/students', async (request, reply) => {
    const body = request.body as { name: string; email: string; dateOfBirth: string };
    const result = await registerStudent(store, clock, body);
    return reply.status(201).send(result);
  });

  // GET /students/:studentId — read student state
  app.get('/students/:studentId', async (request, reply) => {
    const { studentId } = request.params as { studentId: string };
    const { events } = await store.load(studentStream(studentId));
    const state = reduceStudentForRead(events);
    if (state === null) {
      return reply.status(404).send({ error: 'StudentNotFoundError', message: `Student '${studentId}' not found` });
    }
    return reply.status(200).send({
      studentId: state.studentId,
      name: state.name,
      email: state.email,
      dateOfBirth: state.dateOfBirth,
      registeredAt: state.registeredAt,
    });
  });

  // GET /students/:studentId/courses — list per-course enrollment history
  app.get('/students/:studentId/courses', async (request, reply) => {
    const { studentId } = request.params as { studentId: string };

    // Verify student exists before loading enrollment history
    const { events: studentEvents } = await store.load(studentStream(studentId));
    const studentState = reduceStudentForRead(studentEvents);
    if (studentState === null) {
      return reply.status(404).send({ error: 'StudentNotFoundError', message: `Student '${studentId}' not found` });
    }

    const { events } = await store.load(studentEnrollmentHistoryStream(studentId));
    const courseMap = reduceCourseHistory(events);
    const courses = Array.from(courseMap.entries()).map(([courseId, state]) => ({
      courseId,
      ...state,
    }));
    return reply.status(200).send(courses);
  });
}
