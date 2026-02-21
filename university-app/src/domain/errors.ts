export class TeacherNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeacherNotFoundError';
  }
}

export class TeacherAlreadyHiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeacherAlreadyHiredError';
  }
}

export class TeacherDismissedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeacherDismissedError';
  }
}

export class TeacherAssignedToOpenCourseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeacherAssignedToOpenCourseError';
  }
}

export class CourseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseNotFoundError';
  }
}

export class CourseNotInDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseNotInDraftError';
  }
}

export class CourseNotOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseNotOpenError';
  }
}

export class CourseAlreadyCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseAlreadyCancelledError';
  }
}

export class CourseHasActiveEnrollmentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseHasActiveEnrollmentsError';
  }
}

export class CourseNoTeacherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseNoTeacherError';
  }
}

export class PrerequisiteNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrerequisiteNotFoundError';
  }
}

export class InvalidCreditHoursError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCreditHoursError';
  }
}

export class InvalidMaxStudentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMaxStudentsError';
  }
}

export class InvalidPassingGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPassingGradeError';
  }
}

export class StudentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentNotFoundError';
  }
}

export class StudentAlreadyRegisteredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentAlreadyRegisteredError';
  }
}

export class StudentAlreadyEnrolledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentAlreadyEnrolledError';
  }
}

export class EnrollmentFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentFullError';
  }
}

export class PrerequisiteNotSatisfiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrerequisiteNotSatisfiedError';
  }
}

export class StudentNotEnrolledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentNotEnrolledError';
  }
}

export class StudentAlreadyGradedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudentAlreadyGradedError';
  }
}

export class WrongTeacherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongTeacherError';
  }
}

export class UnenrollAfterDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnenrollAfterDeadlineError';
  }
}

export class InvalidGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGradeError';
  }
}
