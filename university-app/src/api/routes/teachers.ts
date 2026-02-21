import type { FastifyInstance } from 'fastify';
import type { EventStore, StoredEvent } from 'es-dcb-library';
import { query } from 'es-dcb-library';
import type { Clock } from '../../domain/clock.js';
import { hireTeacher } from '../../commands/hire-teacher.js';
import { dismissTeacher } from '../../commands/dismiss-teacher.js';

function teacherStream(teacherId: string) {
  return query
    .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
    .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
}

function reduceTeacherForRead(events: StoredEvent[]) {
  let state: {
    status: 'none' | 'hired' | 'dismissed';
    teacherId?: string;
    name?: string;
    email?: string;
    department?: string;
    hiredAt?: string;
    dismissedAt?: string;
  } = { status: 'none' };
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'TeacherHired') {
      state = {
        status: 'hired',
        teacherId: p['teacherId'] as string,
        name: p['name'] as string,
        email: p['email'] as string,
        department: p['department'] as string,
        hiredAt: p['hiredAt'] as string,
      };
    } else if (event.type === 'TeacherDismissed') {
      state = { ...state, status: 'dismissed', dismissedAt: p['dismissedAt'] as string };
    }
  }
  return state;
}

export async function registerTeacherRoutes(
  app: FastifyInstance,
  store: EventStore,
  clock: Clock,
): Promise<void> {
  // POST /teachers — hire a teacher
  app.post('/teachers', async (request, reply) => {
    const body = request.body as { name: string; email: string; department: string };
    const result = await hireTeacher(store, clock, body);
    return reply.status(201).send(result);
  });

  // POST /teachers/:teacherId/dismiss — dismiss a teacher
  app.post('/teachers/:teacherId/dismiss', async (request, reply) => {
    const { teacherId } = request.params as { teacherId: string };
    const body = request.body as { reason: string };
    await dismissTeacher(store, clock, { teacherId, reason: body.reason ?? '' });
    return reply.status(201).send({});
  });

  // GET /teachers/:teacherId — read teacher state
  app.get('/teachers/:teacherId', async (request, reply) => {
    const { teacherId } = request.params as { teacherId: string };
    const { events } = await store.load(teacherStream(teacherId));
    const state = reduceTeacherForRead(events);
    if (state.status === 'none') {
      return reply.status(404).send({ error: 'TeacherNotFoundError', message: `Teacher '${teacherId}' not found` });
    }
    return reply.status(200).send(state);
  });
}
