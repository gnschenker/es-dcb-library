import { defineProjection, createEventDispatcher } from 'es-dcb-library/projections';
import { query } from 'es-dcb-library';
import type { TeacherHiredPayload, TeacherDismissedPayload } from '../domain/events.js';

export const teachersProjection = defineProjection({
  name: 'teachers-read-model',

  query: query
    .eventsOfType('TeacherHired')
    .eventsOfType('TeacherDismissed'),

  async setup(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS read_teachers (
        teacher_id    TEXT        PRIMARY KEY,
        name          TEXT        NOT NULL,
        email         TEXT        NOT NULL,
        department    TEXT        NOT NULL,
        status        TEXT        NOT NULL,
        hired_at      TIMESTAMPTZ NOT NULL,
        dismissed_at  TIMESTAMPTZ
      )
    `);
  },

  handler: createEventDispatcher({
    TeacherHired: async (payload, _event, client) => {
      const p = payload as unknown as TeacherHiredPayload;
      await client.query(
        `INSERT INTO read_teachers (teacher_id, name, email, department, status, hired_at)
         VALUES ($1, $2, $3, $4, 'hired', $5)
         ON CONFLICT (teacher_id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           department = EXCLUDED.department,
           status = 'hired',
           hired_at = EXCLUDED.hired_at,
           dismissed_at = NULL`,
        [p.teacherId, p.name, p.email, p.department, p.hiredAt],
      );
    },
    TeacherDismissed: async (payload, _event, client) => {
      const p = payload as unknown as TeacherDismissedPayload;
      await client.query(
        `UPDATE read_teachers SET status = 'dismissed', dismissed_at = $1 WHERE teacher_id = $2`,
        [p.dismissedAt, p.teacherId],
      );
    },
  }),
});
