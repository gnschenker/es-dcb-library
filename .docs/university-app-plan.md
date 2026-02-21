# University Example Application — Design Plan

> **Purpose:** A sample application demonstrating the DCB event sourcing pattern using `es-dcb-library`. Models a university domain: teacher hiring, course section management, student enrollment, grading, and completion.
>
> **Review status:** v2 — updated following senior product/university-operations review.

---

## 1. Scope

**In scope:**
- Backend logic only (no frontend)
- HTTP API whose endpoints mirror domain commands 1-to-1, plus `GET` read endpoints (state replayed from events on demand)
- Event sourcing via `es-dcb-library` (PostgreSQL-backed)
- In-process state reconstruction from events on each request (no separate read-model store)

**Out of scope (MVP):**
- Authentication / authorisation (`gradedBy` / `teacherId` trusted from request body as a placeholder)
- Persistent read models / projections
- Email notifications
- Waitlist management (noted as a production requirement)
- Academic standing / GPA computation (noted as a production requirement)
- Maximum credit load per semester (noted as a production requirement)
- Grade appeal / correction workflow (noted as a production requirement)
- Student status transitions beyond `registered` (leave of absence, graduated, expelled)

---

## 2. Domain Overview

### Key modelling decision — Course vs. Course Section

A **Course** in this model represents a single *concrete offering* of a subject in a specific semester (e.g., "Introduction to CS, Fall 2026, max 30 students, Prof. Smith"). It is not an abstract catalogue entry. This keeps the model simple: one `courseId` = one schedulable, enrollable, gradable unit. If a subject is taught again in Spring 2027, a new `courseId` is created.

### Entities

| Entity | Description |
|--------|-------------|
| **Teacher** | A person hired by the university. Identified by `teacherId` (UUID derived deterministically from `email` — see §8). |
| **Course** | One scheduled offering of a subject in a specific semester: title, semester, credit hours, max enrollment cap, an ordered prerequisite list, passing grade threshold, and exactly one assigned teacher. Identified by `courseId` (UUID). |
| **Student** | A person registered at the university. Identified by `studentId` (UUID derived from `email`). |
| **Enrollment** | A student's registration in a specific course. Compound key `(studentId, courseId)`. Lifecycle: `enrolled → graded → passed | failed`. |

### Lifecycle State Machines

```
Teacher:
  (none) ──HireTeacher──► hired ──DismissTeacher──► dismissed
           ◄──HireTeacher────────────────────────── dismissed  (re-hire allowed)

Course:
  (none) ──CreateCourse──► draft ──PublishCourse──► open ──CloseCourse──► closed
                              │                       │
                              └──CancelCourse──► cancelled
                                                 open ──CancelCourse──► cancelled

Enrollment:
  (none) ──EnrollStudent──► enrolled
            ◄──UnenrollStudent (drop, before drop deadline)
            ◄──UnenrollStudent (withdrawal, before withdrawal deadline)
          enrolled ──GradeStudent──► graded → (system resolves outcome)
          graded ──► passed  (grade ≥ passingGrade)
          graded ──► failed  (grade < passingGrade)
```

---

## 3. Event Catalog

All events stored in the single `events` table via `es-dcb-library`.

### Teacher Events

| Event Type | Payload Fields | Produced by Command |
|------------|---------------|---------------------|
| `TeacherHired` | `teacherId`, `name`, `email`, `department`, `hiredAt` | `HireTeacher` |
| `TeacherDismissed` | `teacherId`, `reason`, `dismissedAt` | `DismissTeacher` |

> Teachers may be re-hired after dismissal. The most recent `TeacherHired` or `TeacherDismissed` event determines current status.

### Course Events

| Event Type | Payload Fields | Produced by Command |
|------------|---------------|---------------------|
| `CourseCreated` | `courseId`, `title`, `semester`, `creditHours`, `maxStudents`, `prerequisites: string[]`, `passingGrade` | `CreateCourse` |
| `CoursePublished` | `courseId`, `teacherId`, `maxStudents`, `creditHours`, `prerequisites[]`, `passingGrade` | `PublishCourse` |
| `CourseClosed` | `courseId`, `closedAt` | `CloseCourse` |
| `CourseCancelled` | `courseId`, `reason`, `cancelledAt` | `CancelCourse` |
| `TeacherAssignedToCourse` | `courseId`, `teacherId`, `assignedAt` | `AssignTeacherToCourse` |
| `TeacherRemovedFromCourse` | `courseId`, `teacherId`, `removedAt` | `RemoveTeacherFromCourse` |

> `CoursePublished` carries a fat payload for downstream projections (no need to replay the full course stream to understand a publish event).

### Student Events

| Event Type | Payload Fields | Produced by Command |
|------------|---------------|---------------------|
| `StudentRegistered` | `studentId`, `name`, `email`, `dateOfBirth`, `registeredAt` | `RegisterStudent` |

### Enrollment Events

| Event Type | Payload Fields | Produced by Command |
|------------|---------------|---------------------|
| `StudentEnrolled` | `studentId`, `courseId`, `enrolledAt` | `EnrollStudent` |
| `StudentDropped` | `studentId`, `courseId`, `droppedAt`, `droppedBy` | `UnenrollStudent` (before drop deadline) |
| `StudentWithdrew` | `studentId`, `courseId`, `withdrewAt`, `withdrewBy` | `UnenrollStudent` (after drop deadline, before withdrawal deadline) |
| `StudentGraded` | `studentId`, `courseId`, `grade` (0–100), `gradedBy` (`teacherId`), `gradedAt` | `GradeStudent` |
| `StudentPassedCourse` | `studentId`, `courseId`, `finalGrade`, `creditHours`, `semester` | `GradeStudent` (when grade ≥ passingGrade) |
| `StudentFailedCourse` | `studentId`, `courseId`, `finalGrade`, `creditHours`, `semester` | `GradeStudent` (when grade < passingGrade) |

> `StudentPassedCourse` and `StudentFailedCourse` are appended atomically in the same transaction as `StudentGraded`. `creditHours` and `semester` are denormalised from the course for transcript use.
>
> `StudentDropped` and `StudentWithdrew` are distinct events because they have different meaning for transcripts: a drop does not appear; a withdrawal appears as "W".

---

## 4. Business Rules

### Teacher rules
- **BR-T1:** `email` must be unique among currently `hired` teachers. Enforced via deterministic `teacherId = uuidv5(email, NAMESPACE)` — two hire attempts for the same email land on the same stream, and the first-write-at-version-0 advisory lock ensures only one succeeds.
- **BR-T2:** A dismissed teacher may be re-hired (bidirectional state machine). Re-hiring appends a new `TeacherHired` event on the same stream.
- **BR-T3:** A teacher must be in `hired` state (most recent terminal event is `TeacherHired`) before being assigned to a course.
- **BR-T4:** A `hired` teacher may not be dismissed if they are currently assigned to an `open` course (courses in `draft` state have their assignment automatically removed by `DismissTeacher`).

### Course rules
- **BR-C1:** `courseId` must be unique. Enforced by first-write-at-version-0 advisory lock on `courseStream(courseId)`.
- **BR-C2:** A course must be in `draft` state before it can be published.
- **BR-C3:** Students can only enroll in `open` (published) courses.
- **BR-C4:** Prerequisites must reference courseIds for which a `CourseCreated` event exists (course definition must exist in the catalog regardless of its current status).
- **BR-C5:** A course must have an assigned teacher (in `hired` state) before it can be published.
- **BR-C6:** `maxStudents` must be ≥ 1 (enforced at creation and verified again at publish time).
- **BR-C7:** `passingGrade` must be in range 0–100 (default: 60).
- **BR-C8:** `creditHours` must be a positive integer (1–6).
- **BR-C9:** A `closed` course with no active enrollments may be cancelled. An `open` course may be cancelled; this automatically produces `StudentDropped` or `StudentWithdrew` events for all active enrollments (based on current date vs. course deadlines).
- **BR-C10:** A `closed` course cannot be re-opened.

### Enrollment rules
- **BR-E1:** A student must be `registered` before enrolling.
- **BR-E2:** A student may not have an *active* enrollment (`enrolled` or `graded` state) in the same course. A student whose most recent enrollment ended in `StudentPassedCourse`, `StudentFailedCourse`, `StudentDropped`, or `StudentWithdrew` may re-enroll (subject to other guards).
- **BR-E3:** The count of `StudentEnrolled` minus `StudentDropped` and `StudentWithdrew` events in `courseEnrollmentStream(courseId)` must be < `maxStudents` at the time of enrollment.
- **BR-E4:** For every `courseId` in the course's `prerequisites` list, the student's most recent terminal enrollment event for that course must be `StudentPassedCourse`. A `StudentFailedCourse` or no event does not satisfy the prerequisite.
- **BR-E5:** Grading can only be performed by the teacher currently assigned to the course AND whose current status is `hired` (not dismissed).
- **BR-E6:** Only a student in `enrolled` state can be graded.
- **BR-E7:** The pass/fail outcome is determined automatically by `GradeStudent` based on `grade >= course.passingGrade`. There is no separate `CompleteStudent` command.
- **BR-E8:** A student in `graded` state (outcome already recorded) cannot be graded again.
- **BR-E9:** Unenrollment (drop or withdrawal) is not permitted once a student has been graded.
- **BR-E10:** `UnenrollStudent` before the course's `dropDeadline` produces `StudentDropped`. Between `dropDeadline` and `withdrawalDeadline` it produces `StudentWithdrew`. After `withdrawalDeadline`, unenrollment is blocked (requires admin override, out of scope for MVP).

---

## 5. Event Stream Definitions

```typescript
// Teacher lifecycle
const teacherStream = (teacherId: string) =>
  query.eventsOfType('TeacherHired').where.key('teacherId').equals(teacherId)
       .eventsOfType('TeacherDismissed').where.key('teacherId').equals(teacherId);

// Course lifecycle (excluding enrollments — separate stream for concurrency)
const courseStream = (courseId: string) =>
  query.eventsOfType('CourseCreated').where.key('courseId').equals(courseId)
       .eventsOfType('CoursePublished').where.key('courseId').equals(courseId)
       .eventsOfType('CourseClosed').where.key('courseId').equals(courseId)
       .eventsOfType('CourseCancelled').where.key('courseId').equals(courseId)
       .eventsOfType('TeacherAssignedToCourse').where.key('courseId').equals(courseId)
       .eventsOfType('TeacherRemovedFromCourse').where.key('courseId').equals(courseId);

// Enrollment events for a course — used for capacity concurrency check
const courseEnrollmentStream = (courseId: string) =>
  query.eventsOfType('StudentEnrolled').where.key('courseId').equals(courseId)
       .eventsOfType('StudentDropped').where.key('courseId').equals(courseId)
       .eventsOfType('StudentWithdrew').where.key('courseId').equals(courseId);

// All events for a student — used to check registration and prerequisite completion
const studentStream = (studentId: string) =>
  query.eventsOfType('StudentRegistered').where.key('studentId').equals(studentId)
       .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
       .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);

// Enrollment lifecycle for a specific (student, course) pair
const enrollmentStream = (studentId: string, courseId: string) =>
  query.eventsOfType('StudentEnrolled')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
       .eventsOfType('StudentDropped')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
       .eventsOfType('StudentWithdrew')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
       .eventsOfType('StudentGraded')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
       .eventsOfType('StudentPassedCourse')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId)
       .eventsOfType('StudentFailedCourse')
       .where.key('studentId').equals(studentId).and.key('courseId').equals(courseId);
```

---

## 6. State Reducers

Each reducer is a pure function `(events: StoredEvent[]) → State`. Events are always in `globalPosition` order.

```typescript
// Teacher state
type TeacherStatus = 'none' | 'hired' | 'dismissed';
interface TeacherState { status: TeacherStatus; name?: string; email?: string; department?: string; }

function reduceTeacher(events: StoredEvent[]): TeacherState {
  const state: TeacherState = { status: 'none' };
  for (const e of events) {
    if (e.type === 'TeacherHired')    Object.assign(state, { ...e.payload, status: 'hired' });
    if (e.type === 'TeacherDismissed') state.status = 'dismissed';
  }
  return state;
}

// Course state
type CourseStatus = 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
interface CourseState {
  status: CourseStatus; title?: string; semester?: string; creditHours?: number;
  maxStudents?: number; prerequisites?: string[]; passingGrade?: number;
  teacherId?: string | null; dropDeadline?: string; withdrawalDeadline?: string;
}

function reduceCourse(events: StoredEvent[]): CourseState {
  const state: CourseState = { status: 'none', teacherId: null };
  for (const e of events) {
    switch (e.type) {
      case 'CourseCreated':             Object.assign(state, { ...e.payload, status: 'draft' }); break;
      case 'CoursePublished':           state.status = 'open'; break;
      case 'CourseClosed':              state.status = 'closed'; break;
      case 'CourseCancelled':           state.status = 'cancelled'; break;
      case 'TeacherAssignedToCourse':   state.teacherId = (e.payload as any).teacherId; break;
      case 'TeacherRemovedFromCourse':  state.teacherId = null; break;
    }
  }
  return state;
}

// Enrollment state for (studentId, courseId) pair
type EnrollmentStatus = 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
interface EnrollmentState { status: EnrollmentStatus; grade?: number; }

function reduceEnrollment(events: StoredEvent[]): EnrollmentState {
  const state: EnrollmentState = { status: 'none' };
  for (const e of events) {
    switch (e.type) {
      case 'StudentEnrolled':       state.status = 'enrolled'; break;
      case 'StudentDropped':        state.status = 'dropped'; break;
      case 'StudentWithdrew':       state.status = 'withdrew'; break;
      case 'StudentGraded':         Object.assign(state, { status: 'graded', grade: (e.payload as any).grade }); break;
      case 'StudentPassedCourse':   state.status = 'passed'; break;
      case 'StudentFailedCourse':   state.status = 'failed'; break;
    }
  }
  return state;
}

// Student prerequisite state — returns Set of completed courseIds
function reduceStudentCompletedCourses(events: StoredEvent[]): Map<string, 'passed' | 'failed'> {
  const outcomes = new Map<string, 'passed' | 'failed'>();
  for (const e of events) {
    if (e.type === 'StudentPassedCourse') outcomes.set((e.payload as any).courseId, 'passed');
    if (e.type === 'StudentFailedCourse') outcomes.set((e.payload as any).courseId, 'failed');
  }
  return outcomes;  // most recent outcome per courseId wins (events are in globalPosition order)
}
```

---

## 7. Command Handlers — Detail

### `HireTeacher`
- **ID strategy:** `teacherId = uuidv5(email, UNIVERSITY_NAMESPACE)` — deterministic from email. Two attempts with the same email map to the same stream.
- Load: `teacherStream(teacherId)`
- Guards: current status is `none` or `dismissed` (re-hire allowed); if `dismissed`, the re-hire is valid
- Concurrency: `teacherStream(teacherId)`, `expectedVersion` from load (version `0n` on first hire)
- Produces: `TeacherHired`

### `DismissTeacher`
- Load: `teacherStream(teacherId)` + all `courseStream(courseId)` for courses where teacher is assigned
- Guards: teacher is `hired`; teacher is not currently assigned to any `open` course (BR-T4); for any `draft` courses with this teacher assigned, auto-produce `TeacherRemovedFromCourse` as part of the same transaction
- Concurrency: `teacherStream(teacherId)`, `expectedVersion` from load
- Produces: `TeacherDismissed` (+ zero or more `TeacherRemovedFromCourse` for draft courses)
- **Known limitation:** The cross-stream check for open course assignments reads without a lock — see §9.

### `CreateCourse`
- Load: `courseStream(newCourseId)` — must be at version `0n`
- Guards: all `prerequisites` courseIds have a `CourseCreated` event in their stream; `creditHours` 1–6; `maxStudents` ≥ 1; `passingGrade` 0–100
- Concurrency: `courseStream(courseId)`, `expectedVersion: 0n`
- Produces: `CourseCreated`

### `AssignTeacherToCourse`
- Load: `courseStream(courseId)` + `teacherStream(teacherId)`
- Guards: course exists and is in `draft` or `open` state; teacher is `hired`
- Concurrency: `courseStream(courseId)`, `expectedVersion` from course load
- Produces: `TeacherAssignedToCourse`

### `RemoveTeacherFromCourse`
- Load: `courseStream(courseId)`
- Guards: course exists; course has a currently assigned teacher; if course is `open` with active enrollments, removal is blocked (teacher must be replaced, not merely removed — use `AssignTeacherToCourse` instead to swap)
- Concurrency: `courseStream(courseId)`, `expectedVersion` from course load
- Produces: `TeacherRemovedFromCourse`

### `PublishCourse`
- Load: `courseStream(courseId)` + `teacherStream(state.teacherId)`
- Guards: course is in `draft`; has an assigned teacher; teacher is currently `hired` (BR-T3); `maxStudents` ≥ 1
- Concurrency: `courseStream(courseId)`, `expectedVersion` from course load
- Produces: `CoursePublished` (fat payload: includes `teacherId`, `maxStudents`, `creditHours`, `prerequisites[]`, `passingGrade`)

### `CloseCourse`
- Load: `courseStream(courseId)` + `courseEnrollmentStream(courseId)` to count active enrollments
- Guards: course is `open`; no students in `enrolled` state (or: allow close only if all students are graded)
- Concurrency: `courseStream(courseId)`, `expectedVersion` from course load
- Produces: `CourseClosed`

### `CancelCourse`
- Load: `courseStream(courseId)` + `courseEnrollmentStream(courseId)` (to find all currently enrolled students)
- Guards: course is in `draft`, `open`, or `closed` (not already `cancelled`)
- Action: for each active enrollment (status `enrolled`), produce `StudentDropped` or `StudentWithdrew` based on course deadlines, then produce `CourseCancelled`
- Concurrency: `courseEnrollmentStream(courseId)` as `concurrencyQuery`; `courseStream(courseId)` as `query`
- Produces: N × (`StudentDropped` | `StudentWithdrew`) + `CourseCancelled` in a single transaction

### `RegisterStudent`
- **ID strategy:** `studentId = uuidv5(email, UNIVERSITY_NAMESPACE)` — deterministic from email
- Load: `studentStream(studentId)`
- Guards: status is `none` (first registration)
- Concurrency: `studentStream(studentId)`, `expectedVersion: 0n`
- Produces: `StudentRegistered`

### `EnrollStudent`
- Load (all in parallel):
  - `studentStream(studentId)` → check registered; build prerequisite outcome map
  - `courseStream(courseId)` → check `open`, get `maxStudents`, `prerequisites[]`, `passingGrade`, `dropDeadline`, `withdrawalDeadline`
  - `enrollmentStream(studentId, courseId)` → check no active enrollment (BR-E2)
  - `courseEnrollmentStream(courseId)` → count active enrollments (BR-E3)
- Guards (in order):
  1. Student is `registered` (BR-E1)
  2. Course is `open` (BR-C3)
  3. No active enrollment (BR-E2): status must not be `enrolled` or `graded`
  4. Active enrollment count < `maxStudents` (BR-E3)
  5. For each prerequisite courseId: student's most recent outcome is `passed` (BR-E4)
- Concurrency: `concurrencyQuery = courseEnrollmentStream(courseId)` (serialises capacity check per course); `query = enrollmentStream(studentId, courseId)` (for the append itself)
- **Note:** Course status check uses snapshot consistency — the course stream is read without a lock relative to `CloseCourse`. Document that a small race window exists (see §9).
- Produces: `StudentEnrolled`

### `UnenrollStudent`
- Load: `enrollmentStream(studentId, courseId)` + `courseStream(courseId)` (for deadlines)
- Guards:
  - Enrollment is in `enrolled` state (BR-E9: graded students cannot unenroll)
  - Current date is before `withdrawalDeadline` (BR-E10)
- Logic:
  - If current date ≤ `dropDeadline` → `StudentDropped`
  - If current date > `dropDeadline` and ≤ `withdrawalDeadline` → `StudentWithdrew`
- Concurrency: `enrollmentStream(studentId, courseId)`, `expectedVersion` from enrollment load
- Produces: `StudentDropped` or `StudentWithdrew`

### `GradeStudent`
- Load: `enrollmentStream(studentId, courseId)` + `courseStream(courseId)` + `teacherStream(gradedBy)`
- Guards:
  - Enrollment is in `enrolled` state (BR-E6); not already graded (BR-E8)
  - `gradedBy` matches `course.teacherId` (BR-E5)
  - Teacher `gradedBy` is currently `hired` (BR-E5 + C-6)
  - Grade is 0–100
- Concurrency: `enrollmentStream(studentId, courseId)`, `expectedVersion` from enrollment load
- Produces (all in one atomic transaction): `StudentGraded` + `StudentPassedCourse` (if grade ≥ passingGrade) or `StudentFailedCourse` (if grade < passingGrade)
- The outcome events carry `creditHours` and `semester` denormalised from the course for transcript purposes.

---

## 8. Deterministic ID Strategy (Email Uniqueness)

Using UUIDv5 (namespace + email) to generate `teacherId` and `studentId` ensures:

1. Two hire/register requests for the same email produce the same `teacherId`/`studentId`.
2. The advisory lock on `teacherStream(teacherId)` / `studentStream(studentId)` — both keyed by that ID — serialises concurrent requests for the same email.
3. The first write at version `0n` succeeds; any duplicate attempt fails with `ConcurrencyError` (409).

```typescript
import { v5 as uuidv5 } from 'uuid';
const UNIVERSITY_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID v1 namespace DNS — replace with project-specific UUID

function teacherIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), UNIVERSITY_NAMESPACE);
}
function studentIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), UNIVERSITY_NAMESPACE);
}
```

> **Note:** In production, teacher and student namespaces should differ to avoid collisions.

---

## 9. API Design

Base path: `/api/v1`

### Command endpoints

| Method | Path | Command | Request Body |
|--------|------|---------|--------------|
| `POST` | `/teachers` | `HireTeacher` | `{ name, email, department }` |
| `POST` | `/teachers/:teacherId/dismiss` | `DismissTeacher` | `{ reason }` |
| `POST` | `/courses` | `CreateCourse` | `{ title, semester, creditHours, maxStudents, prerequisites[], passingGrade?, dropDeadline, withdrawalDeadline }` |
| `PUT` | `/courses/:courseId/teacher` | `AssignTeacherToCourse` | `{ teacherId }` |
| `DELETE` | `/courses/:courseId/teacher` | `RemoveTeacherFromCourse` | — |
| `POST` | `/courses/:courseId/publish` | `PublishCourse` | — |
| `POST` | `/courses/:courseId/close` | `CloseCourse` | — |
| `POST` | `/courses/:courseId/cancel` | `CancelCourse` | `{ reason }` |
| `POST` | `/students` | `RegisterStudent` | `{ name, email, dateOfBirth }` |
| `POST` | `/courses/:courseId/enrollments` | `EnrollStudent` | `{ studentId }` |
| `POST` | `/courses/:courseId/enrollments/:studentId/unenroll` | `UnenrollStudent` | `{ reason, unenrolledBy }` |
| `POST` | `/courses/:courseId/enrollments/:studentId/grade` | `GradeStudent` | `{ grade, teacherId }` |

### Read endpoints (state replayed from events on demand)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/teachers/:teacherId` | Current teacher state |
| `GET` | `/courses/:courseId` | Current course state |
| `GET` | `/courses/:courseId/enrollments` | All current enrollments for a course |
| `GET` | `/students/:studentId` | Current student state |
| `GET` | `/students/:studentId/courses` | Student's enrollment history (all courses) |

### Response conventions
- **201 Created** — command succeeded; body contains the stored event(s)
- **200 OK** — `GET` request; body contains current state derived from event replay
- **409 Conflict** — `ConcurrencyError`; body: `{ error: 'ConcurrencyError', retryable: true, hint: 'Reload and retry' }`
- **422 Unprocessable Entity** — business rule violated; body: `{ error: '<RuleName>', message: '...' }`
- **404 Not Found** — primary URL resource does not exist (e.g., `:courseId` not found)
  - Referenced entities in request body that are not found → **422** (e.g., `studentId` not registered)

> **Note:** `gradedBy` / `teacherId` in request bodies is a placeholder for an authenticated identity. In production, this would be extracted from a JWT/session.

> **Note:** Raw `StoredEvent` objects are returned from command endpoints for demo purposes. In production, responses would be domain DTOs.

---

## 10. Concurrency Strategy Summary

| Command | Lock scope (`concurrencyQuery`) | Rationale |
|---------|--------------------------------|-----------|
| `HireTeacher` | `teacherStream(teacherId)` | Deterministic ID means same email → same stream; version 0n blocks duplicates |
| `DismissTeacher` | `teacherStream(teacherId)` | Prevents double dismiss; re-hire is allowed |
| `CreateCourse` | `courseStream(courseId)` | Version 0n prevents duplicate creation |
| `AssignTeacherToCourse` | `courseStream(courseId)` | Prevents concurrent assignments |
| `RemoveTeacherFromCourse` | `courseStream(courseId)` | Serialises teacher changes |
| `PublishCourse` / `CloseCourse` / `CancelCourse` | `courseStream(courseId)` | State machine transitions |
| `RegisterStudent` | `studentStream(studentId)` | Deterministic ID; version 0n prevents duplicates |
| `EnrollStudent` | `courseEnrollmentStream(courseId)` | Serialises capacity check per course |
| `UnenrollStudent` | `enrollmentStream(studentId, courseId)` | Prevents double unenrollment |
| `GradeStudent` | `enrollmentStream(studentId, courseId)` | Prevents double grading |

### Known race conditions (documented, accepted for MVP)

| Race | Risk level | Notes |
|------|-----------|-------|
| `EnrollStudent` reads `courseStream` without lock; concurrent `CloseCourse` uses `courseStream` lock | Low | A student could enroll in a course that closes in the same millisecond. `courseEnrollmentStream` and `courseStream` locks do not overlap. Mitigation: include `CourseClosed` in `courseEnrollmentStream`, or add a post-enroll guard. Deferred to post-MVP. |
| `DismissTeacher` cross-stream scan for open course assignments is read-only | Low | Between the scan and the `TeacherDismissed` append, a concurrent `AssignTeacherToCourse` could assign this teacher. BR-T4 guard is best-effort. A teacher-assignment index (projection) would resolve this properly. |

---

## 11. Clock Injection

Business rules that depend on current date (`dropDeadline`, `withdrawalDeadline`) must use an injected clock for testability and determinism:

```typescript
interface Clock { now(): Date; }
const systemClock: Clock = { now: () => new Date() };

// Injected into command handlers:
class UniversityCommandHandlers {
  constructor(private store: EventStore, private clock: Clock) {}
}
```

This prevents non-determinism in unit tests and makes event replay behaviour predictable.

---

## 12. File Structure

```
university-app/
├── package.json                    # Dependencies: es-dcb-library, fastify, pg, uuid
├── tsconfig.json
├── src/
│   ├── index.ts                    # Entry point: create store, start server
│   ├── store.ts                    # Singleton PostgresEventStore factory
│   ├── domain/
│   │   ├── events.ts               # TypeScript payload interfaces for all events
│   │   ├── errors.ts               # Domain error classes (TeacherNotFound, EnrollmentFull, etc.)
│   │   ├── streams.ts              # All stream query definitions
│   │   ├── reducers.ts             # Pure state reduction functions
│   │   └── ids.ts                  # Deterministic ID generation (uuidv5)
│   ├── commands/
│   │   ├── hire-teacher.ts
│   │   ├── dismiss-teacher.ts
│   │   ├── create-course.ts
│   │   ├── assign-teacher.ts
│   │   ├── remove-teacher.ts
│   │   ├── publish-course.ts
│   │   ├── close-course.ts
│   │   ├── cancel-course.ts
│   │   ├── register-student.ts
│   │   ├── enroll-student.ts
│   │   ├── unenroll-student.ts
│   │   └── grade-student.ts
│   └── api/
│       ├── server.ts
│       ├── middleware/error-handler.ts
│       └── routes/
│           ├── teachers.ts         # POST /teachers, POST /teachers/:id/dismiss, GET /teachers/:id
│           ├── courses.ts          # Course + enrollment endpoints
│           └── students.ts         # POST /students, GET /students/:id, GET /students/:id/courses
└── tests/
    ├── unit/                       # Pure reducer and business rule tests (no DB)
    └── integration/                # Full command handler tests (testcontainers PostgreSQL)
```

---

## 13. Technology Stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js 18+ / TypeScript strict |
| HTTP framework | Fastify |
| UUID generation | `uuid` package (uuidv5 for deterministic IDs, v4 for course IDs) |
| Event store | `es-dcb-library` (this repo) |
| Database | PostgreSQL 15 |
| Test runner | Vitest + testcontainers |

---

## 14. Verification Plan

1. **Unit tests** — pure reducer functions: feed event arrays, assert resulting state
2. **Business rule unit tests** — guard functions with controlled state, assert domain errors
3. **Command integration tests** — spin up PostgreSQL via testcontainers, exercise each command, assert returned events
4. **Concurrency integration test** — two simultaneous `EnrollStudent` calls for a course with `maxStudents: 1`; assert exactly one succeeds and the other returns 409
5. **Happy-path smoke test** — full lifecycle:
   - `HireTeacher` → `CreateCourse` → `AssignTeacherToCourse` → `PublishCourse` → `RegisterStudent` → `EnrollStudent` → `GradeStudent` (passing grade) → assert `StudentPassedCourse`
6. **Re-take test** — student fails a course (`StudentFailedCourse`) → re-enrolls → passes → prerequisite satisfied for dependent course
7. **Withdrawal test** — `UnenrollStudent` before drop deadline produces `StudentDropped`; after drop deadline produces `StudentWithdrew`
8. **Re-hire test** — `HireTeacher` → `DismissTeacher` → `HireTeacher` (same email) → succeeds

---

## 15. Resolved Design Decisions

| # | Question | Decision |
|---|---------|----------|
| 1 | Single atomic append for grade + outcome? | Yes. `StudentGraded` + outcome event in one transaction. No `CompleteStudent` command. |
| 2 | Semester concept? | Yes. `semester: string` on `CourseCreated`. Each courseId = one offering in one semester. |
| 3 | Prerequisites = completed or enrolled? | Completed only. `StudentPassedCourse` required; `StudentFailedCourse` or no record does not satisfy. |
| 4 | `maxStudents = 0` at publish? | Blocked at creation (BR-C6) and verified again at publish (BR-C5 / BR-C6). |
| 5 | Dismissed teacher's course assignments? | Auto-remove from `draft` courses. Block dismissal if assigned to `open` courses. |
| 6 | Unenroll after grading? | No. BR-E9 explicitly blocks it. |
| 7 | Grading deadline? | `withdrawalDeadline` added to course. Grading is allowed while course is `open`; blocked after `CloseCourse`. Full `gradingDeadline` deferred to post-MVP. |
| A | Clock injection for temporal rules? | Yes. `Clock` interface injected into command handlers. |
| B | Re-take prerequisite reducer bug? | Handled: `reduceStudentCompletedCourses` uses a `Map<courseId, outcome>` where later events overwrite earlier ones. Most recent outcome wins. |
| C | courseId uniqueness per semester? | Each offering (semester) gets a new UUID. Clients must use the specific `courseId` from `CourseCreated`. |
| D | Retry semantics for enrollment 409? | Response body includes `retryable: true`. Clients should retry with exponential backoff up to 3 times. If still 409, treat as capacity-full and surface as 503 to end user. |
