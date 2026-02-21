import { v5 as uuidv5, v4 as uuidv4 } from 'uuid';

// Valid v4-format UUID namespaces for deterministic ID generation
export const TEACHER_NAMESPACE = '4a8d2c6e-1b3f-5a7d-9e2c-4f6b8a0d3e5f';
export const STUDENT_NAMESPACE = '7c3f9a1d-4b8e-4c2a-8f5d-2e0b4c7a9f3d';

export function teacherIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), TEACHER_NAMESPACE);
}

export function studentIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), STUDENT_NAMESPACE);
}

export function newCourseId(): string {
  return uuidv4();
}
