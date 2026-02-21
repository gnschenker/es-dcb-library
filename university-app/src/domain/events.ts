// Teacher events
export interface TeacherHiredPayload {
  teacherId: string;
  name: string;
  email: string;
  department: string;
  hiredAt: string;
}

export interface TeacherDismissedPayload {
  teacherId: string;
  reason: string;
  dismissedAt: string;
}

// Course events
export interface CourseCreatedPayload {
  courseId: string;
  title: string;
  semester: string;
  creditHours: number;
  maxStudents: number;
  prerequisites: string[];
  passingGrade: number;
  dropDeadline: string;
  withdrawalDeadline: string;
}

export interface CoursePublishedPayload {
  courseId: string;
  teacherId: string;
  maxStudents: number;
  creditHours: number;
  prerequisites: string[];
  passingGrade: number;
}

export interface CourseClosedPayload {
  courseId: string;
  closedAt: string;
}

export interface CourseCancelledPayload {
  courseId: string;
  reason: string;
  cancelledAt: string;
}

export interface TeacherAssignedToCoursePayload {
  courseId: string;
  teacherId: string;
  assignedAt: string;
}

export interface TeacherRemovedFromCoursePayload {
  courseId: string;
  teacherId: string;
  removedAt: string;
}

// Student events
export interface StudentRegisteredPayload {
  studentId: string;
  name: string;
  email: string;
  dateOfBirth: string;
  registeredAt: string;
}

// Enrollment events
export interface StudentEnrolledPayload {
  studentId: string;
  courseId: string;
  enrolledAt: string;
}

export interface StudentDroppedPayload {
  studentId: string;
  courseId: string;
  droppedAt: string;
  droppedBy: string;
}

export interface StudentWithdrewPayload {
  studentId: string;
  courseId: string;
  withdrewAt: string;
  withdrewBy: string;
}

export interface StudentGradedPayload {
  studentId: string;
  courseId: string;
  grade: number;
  gradedBy: string;
  gradedAt: string;
}

export interface StudentPassedCoursePayload {
  studentId: string;
  courseId: string;
  finalGrade: number;
  creditHours: number;
  semester: string;
}

export interface StudentFailedCoursePayload {
  studentId: string;
  courseId: string;
  finalGrade: number;
  creditHours: number;
  semester: string;
}

export type EventPayloadMap = {
  TeacherHired: TeacherHiredPayload;
  TeacherDismissed: TeacherDismissedPayload;
  CourseCreated: CourseCreatedPayload;
  CoursePublished: CoursePublishedPayload;
  CourseClosed: CourseClosedPayload;
  CourseCancelled: CourseCancelledPayload;
  TeacherAssignedToCourse: TeacherAssignedToCoursePayload;
  TeacherRemovedFromCourse: TeacherRemovedFromCoursePayload;
  StudentRegistered: StudentRegisteredPayload;
  StudentEnrolled: StudentEnrolledPayload;
  StudentDropped: StudentDroppedPayload;
  StudentWithdrew: StudentWithdrewPayload;
  StudentGraded: StudentGradedPayload;
  StudentPassedCourse: StudentPassedCoursePayload;
  StudentFailedCourse: StudentFailedCoursePayload;
};
