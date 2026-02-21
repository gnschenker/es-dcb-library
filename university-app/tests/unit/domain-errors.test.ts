import { describe, it, expect } from 'vitest';
import {
  TeacherNotFoundError,
  TeacherAlreadyHiredError,
  TeacherDismissedError,
  TeacherAssignedToOpenCourseError,
  CourseNotFoundError,
  CourseNotInDraftError,
  CourseNotOpenError,
  CourseAlreadyCancelledError,
  CourseHasActiveEnrollmentsError,
  CourseNoTeacherError,
  PrerequisiteNotFoundError,
  InvalidCreditHoursError,
  InvalidMaxStudentsError,
  InvalidPassingGradeError,
  StudentNotFoundError,
  StudentAlreadyRegisteredError,
  StudentAlreadyEnrolledError,
  EnrollmentFullError,
  PrerequisiteNotSatisfiedError,
  StudentNotEnrolledError,
  StudentAlreadyGradedError,
  WrongTeacherError,
  UnenrollAfterDeadlineError,
  InvalidGradeError,
} from '../../src/domain/errors.js';

const errorClasses = [
  { cls: TeacherNotFoundError, name: 'TeacherNotFoundError' },
  { cls: TeacherAlreadyHiredError, name: 'TeacherAlreadyHiredError' },
  { cls: TeacherDismissedError, name: 'TeacherDismissedError' },
  { cls: TeacherAssignedToOpenCourseError, name: 'TeacherAssignedToOpenCourseError' },
  { cls: CourseNotFoundError, name: 'CourseNotFoundError' },
  { cls: CourseNotInDraftError, name: 'CourseNotInDraftError' },
  { cls: CourseNotOpenError, name: 'CourseNotOpenError' },
  { cls: CourseAlreadyCancelledError, name: 'CourseAlreadyCancelledError' },
  { cls: CourseHasActiveEnrollmentsError, name: 'CourseHasActiveEnrollmentsError' },
  { cls: CourseNoTeacherError, name: 'CourseNoTeacherError' },
  { cls: PrerequisiteNotFoundError, name: 'PrerequisiteNotFoundError' },
  { cls: InvalidCreditHoursError, name: 'InvalidCreditHoursError' },
  { cls: InvalidMaxStudentsError, name: 'InvalidMaxStudentsError' },
  { cls: InvalidPassingGradeError, name: 'InvalidPassingGradeError' },
  { cls: StudentNotFoundError, name: 'StudentNotFoundError' },
  { cls: StudentAlreadyRegisteredError, name: 'StudentAlreadyRegisteredError' },
  { cls: StudentAlreadyEnrolledError, name: 'StudentAlreadyEnrolledError' },
  { cls: EnrollmentFullError, name: 'EnrollmentFullError' },
  { cls: PrerequisiteNotSatisfiedError, name: 'PrerequisiteNotSatisfiedError' },
  { cls: StudentNotEnrolledError, name: 'StudentNotEnrolledError' },
  { cls: StudentAlreadyGradedError, name: 'StudentAlreadyGradedError' },
  { cls: WrongTeacherError, name: 'WrongTeacherError' },
  { cls: UnenrollAfterDeadlineError, name: 'UnenrollAfterDeadlineError' },
  { cls: InvalidGradeError, name: 'InvalidGradeError' },
] as const;

describe('Domain errors', () => {
  for (const { cls, name } of errorClasses) {
    describe(name, () => {
      it('is instanceof Error', () => {
        const err = new cls('test message');
        expect(err).toBeInstanceOf(Error);
      });

      it('has correct name', () => {
        const err = new cls('test message');
        expect(err.name).toBe(name);
      });

      it('has correct message', () => {
        const err = new cls('my error message');
        expect(err.message).toBe('my error message');
      });
    });
  }

  it('TeacherNotFoundError is not instanceof CourseNotFoundError', () => {
    const err = new TeacherNotFoundError('not found');
    expect(err).not.toBeInstanceOf(CourseNotFoundError);
  });

  it('StudentNotFoundError is not instanceof TeacherNotFoundError', () => {
    const err = new StudentNotFoundError('not found');
    expect(err).not.toBeInstanceOf(TeacherNotFoundError);
  });
});
