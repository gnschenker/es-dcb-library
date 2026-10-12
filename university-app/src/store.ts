import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';
import type { EventStore, TagExtractor } from 'es-dcb-library';

// Tag extractors derive tags from event data for all university-app events
export const tagExtractors: Record<string, TagExtractor> = {
  // Teacher events
  TeacherHired: (event) => [`teacher:${event.data['teacherId']}`],
  TeacherDismissed: (event) => [`teacher:${event.data['teacherId']}`],
  
  // Course events
  CourseCreated: (event) => [`course:${event.data['courseId']}`],
  CoursePublished: (event) => [
    `course:${event.data['courseId']}`,
    `teacher:${event.data['teacherId']}`,
  ],
  CourseClosed: (event) => [`course:${event.data['courseId']}`],
  CourseCancelled: (event) => [`course:${event.data['courseId']}`],
  TeacherAssignedToCourse: (event) => [
    `course:${event.data['courseId']}`,
    `teacher:${event.data['teacherId']}`,
  ],
  TeacherRemovedFromCourse: (event) => [
    `course:${event.data['courseId']}`,
    `teacher:${event.data['teacherId']}`,
  ],
  
  // Student events
  StudentRegistered: (event) => [`student:${event.data['studentId']}`],
  
  // Enrollment events
  StudentEnrolled: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
  StudentDropped: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
  StudentWithdrew: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
  StudentGraded: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
  StudentPassedCourse: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
  StudentFailedCourse: (event) => [
    `course:${event.data['courseId']}`,
    `student:${event.data['studentId']}`,
  ],
};

export function createStore(connectionString: string): EventStore {
  return new PostgresEventStore({
    pool: new pg.Pool({ connectionString }),
    tagExtractors,
  });
}
