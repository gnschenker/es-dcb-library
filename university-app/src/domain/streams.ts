import { query } from 'es-dcb-library';

export function teacherStream(teacherId: string) {
  return query
    .eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
    .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);
}

export function courseStream(courseId: string) {
  return query
    .eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
    .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
    .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
    .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
    .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);
}

export function courseEnrollmentStream(courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('courseId').equals(courseId);
}

export function studentStream(studentId: string) {
  return query
    .eventsOfType('StudentRegistered').where.key('studentId').equals(studentId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
}

export function enrollmentStream(studentId: string, courseId: string) {
  return query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
}
