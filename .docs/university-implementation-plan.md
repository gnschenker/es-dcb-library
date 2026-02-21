# Implementation Plan: University Example Application

> **Purpose:** Task-by-task implementation plan for the university example application built on top of `es-dcb-library`.
>
> **Design reference:** [`.docs/university-app-plan.md`](.docs/university-app-plan.md) — read this first; it contains the full domain model, event catalog, business rules (BR-T1–BR-E10), command specs, stream definitions, reducers, and API design.
>
> **Location:** `university-app/` subdirectory inside the `es-dcb-library` repo
>
> **Stack:** TypeScript · Fastify · `pg` · `es-dcb-library` · `uuid` · Vitest · testcontainers
>
> **Status values:** `pending` · `in implementation` · `done`
>
> **Concurrency:** Tasks with no overlapping dependencies may be claimed by separate agents simultaneously. Set **Claimed by** to your agent ID when starting a task. Clear it if you abandon the task.

---

## Git Flow (per task)

Every task follows this sequence. Do not skip steps.

### Before starting
```bash
git checkout main && git pull
git checkout -b task/U-XX-short-description
```
Update the task row in the **Task Index** table: **Status** → `in implementation`, **Claimed by** → your agent ID.

### During implementation
Write source files and test files exactly as specified in the task section below. Commit in logical increments on the branch.

### After implementation — verify locally
```bash
cd university-app
npm run typecheck          # must exit 0
npm run test:unit          # must exit 0
npm run test:integration   # must exit 0 (tasks that have integration tests)
```
All checks must be green before opening a PR.

### Push and open a PR
```bash
git push -u origin task/U-XX-short-description

gh pr create \
  --title "feat: U-XX <description>" \
  --body "Implements task U-XX from .docs/university-implementation-plan.md" \
  --base main
```

Spawn a **reviewer agent** (subagent_type: `Plan`) and provide the PR number and the task specification from this document. The reviewer reads the diff with `gh pr diff <number>` and posts a structured review:
```bash
gh pr review <number> --comment --body "..."
```
Issues are categorised: **Critical** / **Medium** (must fix before merge) · **Minor** (implementing agent decides).

### Address issues and push fixes
Fix all Critical and Medium issues on the same branch, re-run all checks, then push. The reviewer posts a follow-up comment. Repeat until no Critical or Medium issues remain.

### Final approval and merge
```bash
gh pr review <number> --approve --body "Approved."
gh pr merge <number> --merge --delete-branch
```

### After merge
```bash
git checkout main && git pull
```
Update the task row: **Status** → `done`, clear **Claimed by**.

---

## Dependency Graph

```
U-01  (Project Scaffolding)
  ├── U-02  (Domain Foundation: event payload types, errors)
  │     └── U-03  (IDs, Streams, Store Factory)
  │           └── U-04  (Domain Reducers)
  │                 ├── U-05  (Teacher Commands)           ─┐
  │                 ├── U-06  (Course Lifecycle Commands)   │ parallelisable
  │                 ├── U-07  (Course Assignment Commands)  │
  │                 ├── U-08  (Student Registration)       ─┘
  │                 └── U-10  (Unit Tests — Reducers & Rules)
  └── U-11  (Integration Test Infrastructure)

U-05 + U-06 + U-07 + U-08 must all be done before:
  └── U-09  (Enrollment Commands)

U-09 + U-11 must be done before:
  └── U-12  (Command Integration Tests)

U-05 + U-06 + U-07 + U-08 + U-09 must all be done before:
  └── U-13  (API Server & Routes)
```

**Parallelisable groups:**
- After U-01: start U-02 and U-11 in parallel
- After U-04: start U-05, U-06, U-07, U-08, and U-10 in parallel
- After U-05+U-06+U-07+U-08: start U-09
- After U-09+U-11: start U-12
- After U-05–U-09 all done: start U-13

---

## Task Index

| ID | Title | Status | Claimed by |
|----|-------|--------|------------|
| U-01 | Project Scaffolding | `done` | — |
| U-02 | Domain Foundation — Event Types & Errors | `done` | — |
| U-03 | Domain Utilities — IDs, Streams, Store Factory | `done` | — |
| U-04 | Domain Reducers | `done` | — |
| U-05 | Teacher Commands | `done` | — |
| U-06 | Course Lifecycle Commands | `done` | — |
| U-07 | Course Teacher Assignment Commands | `done` | — |
| U-08 | Student Registration Command | `done` | — |
| U-09 | Enrollment Commands | `done` | — |
| U-10 | Unit Tests — Reducers & Business Rules | `done` | — |
| U-11 | Integration Test Infrastructure | `done` | — |
| U-12 | Command Integration Tests | `done` | — |
| U-13 | API Server & Routes | `done` | — |

---

## Tasks

---

### U-01 — Project Scaffolding

**Status:** `pending`
**Claimed by:** —
**Depends on:** nothing
**Blocks:** all other tasks

#### Goal
Create the `university-app/` directory inside the `es-dcb-library` repo with all config files and toolchain wiring. No source code yet — only the infrastructure that every subsequent task builds on.

#### Files to create

```
university-app/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/.gitkeep
└── tests/
    ├── unit/.gitkeep
    └── integration/.gitkeep
```

#### Specification

**`package.json`**
- `"name": "university-app"`, `"private": true`, `"type": "module"`
- Scripts: `typecheck`, `test`, `test:unit`, `test:integration`, `test:watch`
- `"engines": { "node": ">=18" }`
- Dependencies:
  - `"es-dcb-library": "file:../"` — local file reference to the library
  - `"fastify": "^5.x"` (latest Fastify 5)
  - `"pg": "^8.13.3"`
  - `"uuid": "^9.0.0"`
- DevDependencies: `@types/node`, `@types/pg`, `typescript ^5.7.3`, `vitest ^3.0.5`, `testcontainers ^10.24.0`

**`tsconfig.json`**
- `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- `"strict": true`, `"exactOptionalPropertyTypes": true`, `"noUncheckedIndexedAccess": true`
- `"include": ["src/**/*", "tests/**/*"]`

**`vitest.config.ts`**
- Two named projects: `"unit"` and `"integration"`
- Unit project: `include: ["tests/unit/**/*.test.ts"]`, `testTimeout: 5000`
- Integration project:
  - `include: ["tests/integration/**/*.test.ts"]`
  - `testTimeout: 60000`
  - `globalSetup: ["./tests/integration/setup.ts"]`
  - `poolOptions: { forks: { singleFork: true } }` (prevents concurrent test files hitting shared PostgreSQL)

#### Acceptance criteria
- [ ] `npm install` completes without errors from within `university-app/`
- [ ] `npm run typecheck` passes (no source files yet — zero errors expected)
- [ ] `npm run test:unit` exits 0 (no tests yet)
- [ ] Directory structure matches the file tree above

---

### U-02 — Domain Foundation — Event Payload Types & Errors

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-01
**Blocks:** U-03

#### Goal
Define TypeScript payload interfaces for all 14 event types and all domain error classes. These are pure type definitions with no I/O dependencies.

#### Files to create
- `university-app/src/domain/events.ts`
- `university-app/src/domain/errors.ts`

#### Specification

**`domain/events.ts`** — one payload interface per event type (see `university-app-plan.md` §3):

```typescript
// Teacher events
export interface TeacherHiredPayload {
  teacherId: string; name: string; email: string; department: string; hiredAt: string;
}
export interface TeacherDismissedPayload { teacherId: string; reason: string; dismissedAt: string; }

// Course events
export interface CourseCreatedPayload {
  courseId: string; title: string; semester: string; creditHours: number;
  maxStudents: number; prerequisites: string[]; passingGrade: number;
  dropDeadline: string; withdrawalDeadline: string; // ISO 8601 date strings
}
export interface CoursePublishedPayload {
  courseId: string; teacherId: string; maxStudents: number;
  creditHours: number; prerequisites: string[]; passingGrade: number;
}
export interface CourseClosedPayload { courseId: string; closedAt: string; }
export interface CourseCancelledPayload { courseId: string; reason: string; cancelledAt: string; }
export interface TeacherAssignedToCoursePayload { courseId: string; teacherId: string; assignedAt: string; }
export interface TeacherRemovedFromCoursePayload { courseId: string; teacherId: string; removedAt: string; }

// Student events
export interface StudentRegisteredPayload {
  studentId: string; name: string; email: string; dateOfBirth: string; registeredAt: string;
}

// Enrollment events
export interface StudentEnrolledPayload { studentId: string; courseId: string; enrolledAt: string; }
export interface StudentDroppedPayload { studentId: string; courseId: string; droppedAt: string; droppedBy: string; }
export interface StudentWithdrewPayload { studentId: string; courseId: string; withdrewAt: string; withdrewBy: string; }
export interface StudentGradedPayload { studentId: string; courseId: string; grade: number; gradedBy: string; gradedAt: string; }
export interface StudentPassedCoursePayload { studentId: string; courseId: string; finalGrade: number; creditHours: number; semester: string; }
export interface StudentFailedCoursePayload { studentId: string; courseId: string; finalGrade: number; creditHours: number; semester: string; }

// Convenience map for type-safe event construction
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
```

**`domain/errors.ts`** — one named error class per business rule violation:

| Class | Trigger |
|-------|---------|
| `TeacherNotFoundError` | teacherId does not exist |
| `TeacherAlreadyHiredError` | hire attempt when already hired |
| `TeacherDismissedError` | action requires hired teacher |
| `TeacherAssignedToOpenCourseError` | BR-T4: dismiss blocked |
| `CourseNotFoundError` | courseId does not exist |
| `CourseNotInDraftError` | BR-C2 |
| `CourseNotOpenError` | BR-C3 / grading requires open |
| `CourseAlreadyCancelledError` | course already cancelled |
| `CourseHasActiveEnrollmentsError` | close blocked / remove teacher blocked |
| `CourseNoTeacherError` | BR-C5 |
| `PrerequisiteNotFoundError` | BR-C4 |
| `InvalidCreditHoursError` | BR-C8 |
| `InvalidMaxStudentsError` | BR-C6 |
| `InvalidPassingGradeError` | BR-C7 |
| `StudentNotFoundError` | studentId does not exist |
| `StudentAlreadyRegisteredError` | duplicate registration |
| `StudentAlreadyEnrolledError` | BR-E2 active enrollment |
| `EnrollmentFullError` | BR-E3 |
| `PrerequisiteNotSatisfiedError` | BR-E4 |
| `StudentNotEnrolledError` | BR-E6 / BR-E9 |
| `StudentAlreadyGradedError` | BR-E8 |
| `WrongTeacherError` | BR-E5 |
| `UnenrollAfterDeadlineError` | BR-E10 |
| `InvalidGradeError` | grade outside 0–100 |

Each error class: `extends Error`, sets `this.name = 'ClassName'` in constructor, calls `super(message)`.

#### Tests
`tests/unit/domain-errors.test.ts`
- Each error is `instanceof Error`
- Each error `.name` matches class name
- Each error `.message` is the constructor argument
- No cross-class `instanceof` confusion

#### Acceptance criteria
- [ ] 15 payload interfaces + `EventPayloadMap` exported from `events.ts`
- [ ] 24 error classes exported from `errors.ts` (note: `CourseNoTeacherError` covers both the publish-without-teacher case BR-C5 and the remove-teacher-when-none-assigned case in U-07)
- [ ] All error unit tests pass
- [ ] `npm run typecheck` passes

---

### U-03 — Domain Utilities — IDs, Streams, Store Factory

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-02
**Blocks:** U-04, U-05, U-06, U-07, U-08, U-09

#### Goal
Implement deterministic ID generation, all stream query definitions, and the PostgreSQL store factory. Shared utilities used by all command handlers.

#### Files to create
- `university-app/src/domain/clock.ts`
- `university-app/src/domain/ids.ts`
- `university-app/src/domain/streams.ts`
- `university-app/src/store.ts`

#### Specification

**`domain/clock.ts`**
```typescript
export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };
```

**`domain/ids.ts`**
```typescript
import { v5 as uuidv5, v4 as uuidv4 } from 'uuid';

// Distinct namespaces prevent teacher/student UUID collision for same email
export const TEACHER_NAMESPACE = '4a8d2c6e-1b3f-5a7d-9e2c-4f6b8a0d3e5f';
export const STUDENT_NAMESPACE = '7c3f9a1d-4b8e-6c2a-8f5d-2e0b4c7a9f3d';

export function teacherIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), TEACHER_NAMESPACE);
}
export function studentIdFromEmail(email: string): string {
  return uuidv5(email.toLowerCase().trim(), STUDENT_NAMESPACE);
}
export function newCourseId(): string { return uuidv4(); }
```

**`domain/streams.ts`** — five stream query builders (exact definitions from `university-app-plan.md` §5):
- `teacherStream(teacherId)` — 2 clauses: `TeacherHired`, `TeacherDismissed`
- `courseStream(courseId)` — 6 clauses: `CourseCreated`, `CoursePublished`, `CourseClosed`, `CourseCancelled`, `TeacherAssignedToCourse`, `TeacherRemovedFromCourse`
- `courseEnrollmentStream(courseId)` — 3 clauses: `StudentEnrolled`, `StudentDropped`, `StudentWithdrew`
- `studentStream(studentId)` — 3 clauses: `StudentRegistered`, `StudentPassedCourse`, `StudentFailedCourse`
- `enrollmentStream(studentId, courseId)` — 6 clauses with AND filters on both `studentId` and `courseId`

Import `query` from `es-dcb-library`: `import { query } from 'es-dcb-library'`.

**`store.ts`**
```typescript
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';
import type { EventStore } from 'es-dcb-library';

export function createStore(connectionString: string): EventStore {
  return new PostgresEventStore({ pool: new pg.Pool({ connectionString }) });
}
```

#### Tests
`tests/unit/domain-ids.test.ts`
- `teacherIdFromEmail` is case-insensitive and trims whitespace (same result for `'Alice@Example.COM'` and `'alice@example.com'`)
- `teacherIdFromEmail('a@b.com') !== studentIdFromEmail('a@b.com')` (different namespaces)
- Same email called twice → same UUID (deterministic)
- `newCourseId()` returns a valid UUID-format string; two calls return different values

`tests/unit/domain-streams.test.ts`
- `teacherStream('t1')._clauses.length === 2`
- `courseStream('c1')._clauses.length === 6`
- `courseEnrollmentStream('c1')._clauses.length === 3`
- `studentStream('s1')._clauses.length === 3`
- `enrollmentStream('s1', 'c1')._clauses.length === 6`
- Each clause's filter contains the correct `key`/`value` pairs (spot-check at least 3 clauses)

#### Acceptance criteria
- [ ] All ID and stream unit tests pass
- [ ] `npm run typecheck` passes

---

### U-04 — Domain Reducers

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-03
**Blocks:** U-05, U-06, U-07, U-08, U-09, U-10

#### Goal
Implement pure state reducer functions. Each takes `StoredEvent[]` in `globalPosition` order and returns a typed state object. Zero I/O.

#### Files to create
- `university-app/src/domain/reducers.ts`

#### Specification

Export (see `university-app-plan.md` §6 for full implementations):

```typescript
import type { StoredEvent } from 'es-dcb-library';

export type TeacherStatus = 'none' | 'hired' | 'dismissed';
export interface TeacherState { status: TeacherStatus; name?: string; email?: string; department?: string; }
export function reduceTeacher(events: StoredEvent[]): TeacherState;
// TeacherHired → spread all payload fields + status='hired'
// TeacherDismissed → status='dismissed' (preserve name/email/department)

export type CourseStatus = 'none' | 'draft' | 'open' | 'closed' | 'cancelled';
export interface CourseState {
  status: CourseStatus; title?: string; semester?: string; creditHours?: number;
  maxStudents?: number; prerequisites?: string[]; passingGrade?: number;
  teacherId?: string | null; dropDeadline?: string; withdrawalDeadline?: string;
}
export function reduceCourse(events: StoredEvent[]): CourseState;
// CourseCreated → spread all payload + status='draft' (sets dropDeadline, withdrawalDeadline)
// TeacherAssignedToCourse → set teacherId; TeacherRemovedFromCourse → teacherId=null
// CoursePublished → status='open' (does NOT overwrite dropDeadline/withdrawalDeadline)

export type EnrollmentStatus = 'none' | 'enrolled' | 'dropped' | 'withdrew' | 'graded' | 'passed' | 'failed';
export interface EnrollmentState { status: EnrollmentStatus; grade?: number; }
export function reduceEnrollment(events: StoredEvent[]): EnrollmentState;
// StudentGraded → status='graded', grade=payload.grade
// StudentPassedCourse/StudentFailedCourse → final status

export function reduceStudentCompletedCourses(events: StoredEvent[]): Map<string, 'passed' | 'failed'>;
// Map<courseId, outcome> — uses Map.set() so later events overwrite earlier (re-take fix)

export function reduceEnrollmentCount(events: StoredEvent[]): number;
// StudentEnrolled → +1; StudentDropped → -1; StudentWithdrew → -1
```

#### Tests
`tests/unit/reducers.test.ts` (≥ 25 test cases):

`reduceTeacher`: empty → `none`; hired; hired+dismissed; hired+dismissed+re-hired; dismissed state preserves name/email.

`reduceCourse`: empty → `{status:'none', teacherId:null}`; created (all fields set); created+assigned; created+assigned+published; created+assigned+published+closed; created+assigned+removed (teacherId null); cancelled; `CoursePublished` does NOT change `dropDeadline`/`withdrawalDeadline`.

`reduceEnrollment`: none; enrolled; dropped; withdrew; graded (grade value preserved); passed; failed.

`reduceStudentCompletedCourses`: single pass; fail then retake pass (later wins); pass then retake fail (later wins); multiple distinct courses.

`reduceEnrollmentCount`: empty→0; enrolled+dropped→0; two enrolled one dropped→1; enrolled+withdrew→0.

#### Acceptance criteria
- [ ] ≥ 25 test cases, all passing
- [ ] Pure functions — no side effects, no I/O
- [ ] `npm run typecheck` passes

---

### U-05 — Teacher Commands

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04
**Blocks:** U-09

#### Goal
Implement `HireTeacher` and `DismissTeacher` command handlers.

#### Files to create
- `university-app/src/commands/hire-teacher.ts`
- `university-app/src/commands/dismiss-teacher.ts`

#### Specification

Each command handler is an `async function(store: EventStore, clock: Clock, input: InputType)`.

**`hire-teacher.ts`**

Input: `{ name: string; email: string; department: string }`
Returns: `Promise<{ teacherId: string }>`

Algorithm:
1. `teacherId = teacherIdFromEmail(email)`
2. `{ events, version } = await store.load(teacherStream(teacherId))`
3. `reduceTeacher(events)` → guard `status === 'hired'` → throw `TeacherAlreadyHiredError`
4. Build `TeacherHired` payload: `{ teacherId, name, email, department, hiredAt: clock.now().toISOString() }`
5. `store.append([event], { query: teacherStream(teacherId), expectedVersion: version })`
6. Return `{ teacherId }`

**`dismiss-teacher.ts`**

Input: `{ teacherId: string; reason: string }`
Returns: `Promise<void>`

Algorithm:
1. `{ events, version } = await store.load(teacherStream(teacherId))`
2. `reduceTeacher(events)` → guard `status === 'none'` → `TeacherNotFoundError`; `status === 'dismissed'` → `TeacherDismissedError`
3. Scan courses assigned to this teacher: `store.stream(query.eventsOfType('TeacherAssignedToCourse').where.key('teacherId').equals(teacherId))`. Collect unique `courseId`s. For each, load `courseStream(courseId)` + `reduceCourse()`.
   > **Known race condition (document in code):** This scan is best-effort. Between steps 3 and 7, a concurrent `AssignTeacherToCourse` could assign this teacher to another course. This is accepted for MVP — see `university-app-plan.md §9`. Add a comment in the implementation referencing this.
4. Guard: any course is `'open'` with this teacher still assigned → throw `TeacherAssignedToOpenCourseError` (BR-T4)
5. For each `'draft'` course with this teacher still assigned (most recent `TeacherAssignedToCourse` not yet superseded by `TeacherRemovedFromCourse`): build `TeacherRemovedFromCourse` event
6. Build `TeacherDismissed` event
7. `store.append([...removedEvents, dismissedEvent], { query: teacherStream(teacherId), expectedVersion: version })`

#### Acceptance criteria
- [ ] Both files compile with zero TypeScript errors
- [ ] `npm run typecheck` passes

---

### U-06 — Course Lifecycle Commands

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04
**Blocks:** U-09, U-13

#### Goal
Implement `CreateCourse`, `PublishCourse`, `CloseCourse`, `CancelCourse`.

#### Files to create
- `university-app/src/commands/create-course.ts`
- `university-app/src/commands/publish-course.ts`
- `university-app/src/commands/close-course.ts`
- `university-app/src/commands/cancel-course.ts`

#### Specification

**`create-course.ts`**

Input: `{ title, semester, creditHours, maxStudents, prerequisites: string[], passingGrade?, dropDeadline, withdrawalDeadline }`
Returns: `Promise<{ courseId: string }>`

1. Validate: `creditHours` 1–6 → `InvalidCreditHoursError`; `maxStudents ≥ 1` → `InvalidMaxStudentsError`; `passingGrade` 0–100, default 60 → `InvalidPassingGradeError`
2. For each `prereqId` in `prerequisites`: load `courseStream(prereqId)` — if no events exist → `PrerequisiteNotFoundError` (BR-C4)
3. `courseId = newCourseId()`
4. `store.append([CourseCreated], { query: courseStream(courseId), expectedVersion: 0n })`
5. Return `{ courseId }`

**`publish-course.ts`**

Input: `{ courseId }`

1. `const { events: courseEvents, version: courseVersion } = await store.load(courseStream(courseId))`
2. `reduceCourse(courseEvents)` → guard `status !== 'draft'` → `CourseNotInDraftError`; `status === 'none'` → `CourseNotFoundError`
3. Guard `state.teacherId == null` → `CourseNoTeacherError`; `state.maxStudents! < 1` → `InvalidMaxStudentsError`
4. `const { events: teacherEvents } = await store.load(teacherStream(state.teacherId!))`; `reduceTeacher(teacherEvents)` → guard `status !== 'hired'` → `TeacherDismissedError`
5. Append `CoursePublished` fat payload: `{ courseId, teacherId, maxStudents, creditHours, prerequisites, passingGrade }`
   > **Note:** `dropDeadline` and `withdrawalDeadline` are intentionally absent from `CoursePublishedPayload` — they are set once on `CourseCreated` and must be read from the full course stream. Downstream projections that need deadlines must replay from `CourseCreated`.
6. `store.append([event], { query: courseStream(courseId), expectedVersion: courseVersion })`

**`close-course.ts`**

Input: `{ courseId }`

1. `const [{ events: courseEvents, version: courseVersion }, { events: enrollmentEvents }] = await Promise.all([store.load(courseStream(courseId)), store.load(courseEnrollmentStream(courseId))])`
2. `reduceCourse(courseEvents)` → guard `status === 'none'` → `CourseNotFoundError`; `status !== 'open'` → `CourseNotOpenError`
3. Collect unique `studentId`s from `enrollmentEvents` where `reduceEnrollmentCount` for that student is > 0 (i.e., they enrolled and did not drop/withdraw). For each such `studentId`, load `enrollmentStream(studentId, courseId)` and call `reduceEnrollment()`. If any student's status is `'enrolled'` (not `'graded'`, `'passed'`, or `'failed'`) → throw `CourseHasActiveEnrollmentsError`.
   > **Why per-student load:** `courseEnrollmentStream` does not include `StudentGraded`/`StudentPassedCourse`/`StudentFailedCourse`, so a student who has been graded appears as "enrolled" when only counting from courseEnrollmentStream events. Loading per-student `enrollmentStream` gives the correct terminal status.
4. `store.append([CourseClosed], { query: courseStream(courseId), expectedVersion: courseVersion })`

**`cancel-course.ts`**

Input: `{ courseId, reason }`

1. `const [{ events: courseEvents, version: courseVersion }, { events: courseEnrollEvents, version: enrollmentVersion }] = await Promise.all([store.load(courseStream(courseId)), store.load(courseEnrollmentStream(courseId))])`
2. `reduceCourse(courseEvents)` → guard:
   - `status === 'none'` → `CourseNotFoundError`
   - `status === 'cancelled'` → `CourseAlreadyCancelledError`
3. Collect unique `studentId`s from `courseEnrollEvents` where net enrollment count > 0 (enrolled, not dropped/withdrew). For each, load `enrollmentStream(studentId, courseId)` and call `reduceEnrollment()`. Keep only students with status `'enrolled'` — skip students with status `'graded'`, `'passed'`, or `'failed'` (BR-E9: graded students cannot be unenrolled).
   > **Why per-student load:** `courseEnrollmentStream` lacks grading events, so a graded student would incorrectly appear as still enrolled. Per-student `enrollmentStream` gives the correct terminal status.
4. For each truly-`'enrolled'` student: if `clock.now() <= new Date(state.dropDeadline!)` → build `StudentDropped`; else → build `StudentWithdrew`. Set `droppedBy`/`withdrewBy` to `'system'` (automated cancellation).
5. Build final event list: `[...unenrollEvents, CourseCancelled]` — all in one atomic append
6. `store.append(events, { query: courseStream(courseId), concurrencyQuery: courseEnrollmentStream(courseId), expectedVersion: enrollmentVersion })`

#### Acceptance criteria
- [ ] All 4 files compile with zero TypeScript errors
- [ ] Guard conditions throw the correct error types
- [ ] `npm run typecheck` passes

---

### U-07 — Course Teacher Assignment Commands

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04
**Blocks:** U-09, U-13

#### Goal
Implement `AssignTeacherToCourse` and `RemoveTeacherFromCourse`.

#### Files to create
- `university-app/src/commands/assign-teacher.ts`
- `university-app/src/commands/remove-teacher.ts`

#### Specification

**`assign-teacher.ts`**

Input: `{ courseId, teacherId }`

1. `const [{ events: courseEvents, version: courseVersion }, { events: teacherEvents }] = await Promise.all([store.load(courseStream(courseId)), store.load(teacherStream(teacherId))])`
2. `reduceCourse(courseEvents)` → guard: `status === 'none'` → `CourseNotFoundError`; `status` not in `['draft','open']` (i.e., `'closed'` or `'cancelled'`) → `CourseNotInDraftError` (assignment requires an active course)
3. `reduceTeacher(teacherEvents)` → guard: `status === 'none'` → `TeacherNotFoundError`; `status === 'dismissed'` → `TeacherDismissedError`
4. Note: Re-assigning the same teacher that is already assigned is allowed — it is idempotent and produces a duplicate `TeacherAssignedToCourse` event. This simplifies the command and is intentional for MVP.
5. Build `TeacherAssignedToCourse` payload: `{ courseId, teacherId, assignedAt: clock.now().toISOString() }`
6. `store.append([event], { query: courseStream(courseId), expectedVersion: courseVersion })`

**`remove-teacher.ts`**

Input: `{ courseId }`

1. `const [{ events: courseEvents, version: courseVersion }, { events: enrollEvents }] = await Promise.all([store.load(courseStream(courseId)), store.load(courseEnrollmentStream(courseId))])`
2. `reduceCourse(courseEvents)` → guards:
   - `status === 'none'` → `CourseNotFoundError`
   - `state.teacherId == null` → `CourseNoTeacherError` (no teacher to remove)
   - `status === 'open'` and `reduceEnrollmentCount(enrollEvents) > 0` → `CourseHasActiveEnrollmentsError` (cannot remove teacher from open course with active students — use `AssignTeacherToCourse` to swap instead)
3. Build `TeacherRemovedFromCourse` payload: `{ courseId, teacherId: state.teacherId!, removedAt: clock.now().toISOString() }`
4. `store.append([event], { query: courseStream(courseId), expectedVersion: courseVersion })`

#### Acceptance criteria
- [ ] Both files compile with zero TypeScript errors
- [ ] `npm run typecheck` passes

---

### U-08 — Student Registration Command

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04
**Blocks:** U-09

#### Goal
Implement `RegisterStudent`.

#### Files to create
- `university-app/src/commands/register-student.ts`

#### Specification

Input: `{ name, email, dateOfBirth }`
Returns: `Promise<{ studentId: string }>`

1. `studentId = studentIdFromEmail(email)`
2. `{ events, version } = await store.load(studentStream(studentId))`
3. Guard: `version > 0n` → `StudentAlreadyRegisteredError`
4. Build `StudentRegistered` payload: `{ studentId, name, email, dateOfBirth, registeredAt: clock.now().toISOString() }`
5. `store.append([event], { query: studentStream(studentId), expectedVersion: 0n })`
6. Return `{ studentId }`

#### Acceptance criteria
- [ ] File compiles with zero TypeScript errors
- [ ] `npm run typecheck` passes

---

### U-09 — Enrollment Commands

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04, U-05, U-06, U-07, U-08
**Blocks:** U-12, U-13

#### Goal
Implement `EnrollStudent`, `UnenrollStudent`, and `GradeStudent` — the most complex commands.

#### Files to create
- `university-app/src/commands/enroll-student.ts`
- `university-app/src/commands/unenroll-student.ts`
- `university-app/src/commands/grade-student.ts`

#### Specification

**`enroll-student.ts`**

Input: `{ studentId, courseId }`

Load all four streams in parallel with explicit variable names:
```typescript
const [
  { events: studentEvents },
  { events: courseEvents },
  { events: enrollmentEvents, version: enrollmentVersion },
  { events: courseEnrollEvents, version: courseEnrollVersion },
] = await Promise.all([
  store.load(studentStream(studentId)),
  store.load(courseStream(courseId)),
  store.load(enrollmentStream(studentId, courseId)),
  store.load(courseEnrollmentStream(courseId)),
]);
```

Guards in order:
1. No `StudentRegistered` event in `studentEvents` → `StudentNotFoundError` (BR-E1)
2. `reduceCourse(courseEvents).status !== 'open'` → `CourseNotOpenError` (BR-C3); `status === 'none'` → `CourseNotFoundError`
3. `reduceEnrollment(enrollmentEvents).status` is `'enrolled'` or `'graded'` → `StudentAlreadyEnrolledError` (BR-E2)
4. `reduceEnrollmentCount(courseEnrollEvents) >= courseState.maxStudents!` → `EnrollmentFullError` (BR-E3)
5. For each `prereqId` in `courseState.prerequisites`: `reduceStudentCompletedCourses(studentEvents).get(prereqId) !== 'passed'` → `PrerequisiteNotSatisfiedError` (BR-E4)

Append:
```typescript
// IMPORTANT: expectedVersion must come from courseEnrollmentStream, NOT enrollmentStream.
// When concurrencyQuery is set, the library version-checks against concurrencyQuery's events.
store.append([StudentEnrolled], {
  query: enrollmentStream(studentId, courseId),
  concurrencyQuery: courseEnrollmentStream(courseId),
  expectedVersion: courseEnrollVersion,  // ← from courseEnrollmentStream load, not enrollmentStream
})
```

**`unenroll-student.ts`**

Input: `{ studentId, courseId, reason, unenrolledBy }`

1. `const [{ events: enrollmentEvents, version: enrollmentVersion }, { events: courseEvents }] = await Promise.all([store.load(enrollmentStream(studentId, courseId)), store.load(courseStream(courseId))])`
2. `reduceEnrollment(enrollmentEvents)` → guard: `status === 'none'` → `StudentNotEnrolledError`; `status` in `['graded','passed','failed']` → `StudentAlreadyGradedError` (BR-E9); `status` in `['dropped','withdrew']` → `StudentNotEnrolledError`
3. `reduceCourse(courseEvents)` → guard: `clock.now() > new Date(courseState.withdrawalDeadline!)` → `UnenrollAfterDeadlineError` (BR-E10)
4. Determine event type and field mapping:
   - `clock.now() <= new Date(courseState.dropDeadline!)` → `StudentDropped` with payload `{ studentId, courseId, droppedAt: clock.now().toISOString(), droppedBy: input.unenrolledBy }`
   - else → `StudentWithdrew` with payload `{ studentId, courseId, withdrewAt: clock.now().toISOString(), withdrewBy: input.unenrolledBy }`
5. `store.append([event], { query: enrollmentStream(studentId, courseId), expectedVersion: enrollmentVersion })`

**`grade-student.ts`**

Input: `{ studentId, courseId, grade, gradedBy }`

1. Validate: `grade < 0 || grade > 100` → `InvalidGradeError`
2. Load `enrollmentStream(studentId, courseId)`, `courseStream(courseId)`, `teacherStream(gradedBy)` in parallel
3. Guards:
   - Enrollment `'none'` → `StudentNotEnrolledError`; already graded → `StudentAlreadyGradedError` (BR-E6, BR-E8)
   - Course `status !== 'open'` → `CourseNotOpenError`
   - `course.teacherId !== gradedBy` → `WrongTeacherError` (BR-E5)
   - Teacher `status !== 'hired'` → `TeacherDismissedError`
4. Build `StudentGraded` + outcome event:
   - `grade >= course.passingGrade!` → `StudentPassedCourse`; else → `StudentFailedCourse`
   - Outcome event carries `creditHours` and `semester` from course state (denormalised for transcripts)
5. `store.append([gradedEvent, outcomeEvent], { query: enrollmentStream(studentId, courseId), expectedVersion: enrollmentVersion })`

#### Acceptance criteria
- [ ] All 3 files compile with zero TypeScript errors
- [ ] Guard conditions throw the correct error types
- [ ] `npm run typecheck` passes

---

### U-10 — Unit Tests — Reducers & Business Rules

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-04
**Blocks:** nothing

#### Goal
Write comprehensive unit tests for all reducers and domain utilities. No database required.

#### Files to create
- `university-app/tests/unit/reducers.test.ts`
- `university-app/tests/unit/domain-errors.test.ts`
- `university-app/tests/unit/domain-ids.test.ts`
- `university-app/tests/unit/domain-streams.test.ts`

These test files supersede any stubs created in earlier tasks. Aim for ≥ 45 unit tests total.

#### Additional test cases (beyond U-04 spec)

**`reduceCourse` edge cases:**
- `CoursePublished` does NOT overwrite `dropDeadline`/`withdrawalDeadline` (set only by `CourseCreated`)
- Multiple `TeacherAssignedToCourse` events → last `teacherId` wins
- `CancelCourse` after `open` state → `status: 'cancelled'`

**`reduceStudentCompletedCourses` edge cases:**
- Student failed then passed same course → Map stores `'passed'` (later wins)
- Events irrelevant to this reducer (`StudentEnrolled`, `StudentGraded`) are ignored
- Many distinct courses → all stored with correct outcomes

**`reduceEnrollmentCount` edge cases:**
- Count never goes below 0
- Mix of `StudentDropped` and `StudentWithdrew` both decrement count

#### Acceptance criteria
- [ ] ≥ 45 unit tests total across all unit test files
- [ ] All tests pass with `npm run test:unit`
- [ ] `npm run typecheck` passes

---

### U-11 — Integration Test Infrastructure

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-01
**Blocks:** U-12

#### Goal
Set up the testcontainers global setup that starts a PostgreSQL 15 container, applies the `es-dcb-library` schema, and provides per-test cleanup helpers.

#### Files to create
- `university-app/tests/integration/setup.ts`
- `university-app/tests/integration/helpers.ts`

#### Specification

**`setup.ts`** — Vitest `globalSetup`:

```typescript
import { PostgreSqlContainer } from 'testcontainers';
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';

let container: any;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:15').start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
  const store = new PostgresEventStore({
    pool: new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }),
  });
  await store.initializeSchema();
  await store.close();
}

export async function teardown() {
  await container.stop();
}
```

**`helpers.ts`**:

```typescript
import pg from 'pg';
import { PostgresEventStore } from 'es-dcb-library';
import type { EventStore } from 'es-dcb-library';

export function createTestStore(): EventStore {
  return new PostgresEventStore({
    pool: new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }),
  });
}

// Lazy pool for TRUNCATE — created on first use to avoid module-load-time issues
// (TEST_DATABASE_URL is set by globalSetup before any test file runs, but using
// lazy init avoids potential problems if helpers.ts is ever imported at load time)
let _adminPool: pg.Pool | undefined;
function getAdminPool(): pg.Pool {
  if (!_adminPool) {
    _adminPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  }
  return _adminPool;
}

export async function clearEvents(): Promise<void> {
  await getAdminPool().query('TRUNCATE events RESTART IDENTITY CASCADE');
}
```

Each integration test file should call `clearEvents()` in a `beforeEach` hook.

#### Acceptance criteria
- [ ] `npm run test:integration` starts a container and exits 0 (even with no test files yet)
- [ ] `clearEvents()` successfully truncates the events table
- [ ] `npm run typecheck` passes

---

### U-12 — Command Integration Tests

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-05, U-06, U-07, U-08, U-09, U-11
**Blocks:** nothing

#### Goal
Write integration tests for all 12 command handlers against real PostgreSQL, including full lifecycle and concurrency scenarios.

#### Files to create
- `university-app/tests/integration/teachers.test.ts`
- `university-app/tests/integration/courses.test.ts`
- `university-app/tests/integration/students.test.ts`
- `university-app/tests/integration/enrollments.test.ts`
- `university-app/tests/integration/concurrency.test.ts`

#### Test scenarios required

**`teachers.test.ts`:**
- `HireTeacher` happy path → `TeacherHired` event with correct payload
- `HireTeacher` same email twice → second throws `TeacherAlreadyHiredError`
- `DismissTeacher` on hired teacher → `TeacherDismissed` appended
- `DismissTeacher` on non-existent teacher → `TeacherNotFoundError`
- `DismissTeacher` twice → second throws `TeacherDismissedError`
- Re-hire after dismissal (same email) → succeeds with new `TeacherHired`
- `DismissTeacher` when teacher is assigned to an `open` course → `TeacherAssignedToOpenCourseError` (BR-T4)
- `DismissTeacher` when teacher is assigned to a `draft` course → auto-produces `TeacherRemovedFromCourse` + `TeacherDismissed` in one transaction; verify both events present

**`courses.test.ts`:**
- `CreateCourse` happy path → `CourseCreated` with all fields
- `CreateCourse` invalid `creditHours` (0 or 7) → `InvalidCreditHoursError`
- `CreateCourse` non-existent prerequisite → `PrerequisiteNotFoundError`
- `CreateCourse` with valid prerequisite (existing courseId) → succeeds
- `AssignTeacherToCourse` → `TeacherAssignedToCourse`
- `PublishCourse` on draft with assigned hired teacher → `CoursePublished`
- `PublishCourse` with no assigned teacher → `CourseNoTeacherError`
- `CloseCourse` on open with no active enrollments → `CourseClosed`
- `CancelCourse` on draft (no enrollments) → `CourseCancelled`
- `CancelCourse` on open with enrolled students → `StudentDropped` events + `CourseCancelled`

**`students.test.ts`:**
- `RegisterStudent` happy path → `StudentRegistered`; returned `studentId` matches deterministic ID
- `RegisterStudent` same email twice → `StudentAlreadyRegisteredError`

**`enrollments.test.ts`:**
- `EnrollStudent` happy path → `StudentEnrolled`
- `EnrollStudent` course not open → `CourseNotOpenError`
- `EnrollStudent` already enrolled → `StudentAlreadyEnrolledError`
- `EnrollStudent` course full (`maxStudents: 1`, one already enrolled) → `EnrollmentFullError`
- `EnrollStudent` with unsatisfied prerequisite → `PrerequisiteNotSatisfiedError` (BR-E4)
- `EnrollStudent` with satisfied prerequisite (student passed required course) → succeeds
- `UnenrollStudent` before drop deadline → `StudentDropped`
- `UnenrollStudent` after drop deadline, before withdrawal deadline → `StudentWithdrew`
- `UnenrollStudent` after withdrawal deadline → `UnenrollAfterDeadlineError`
- `UnenrollStudent` after student is already graded → `StudentAlreadyGradedError` (BR-E9)
- `GradeStudent` passing grade → `StudentGraded` + `StudentPassedCourse` (with `creditHours`, `semester`)
- `GradeStudent` failing grade → `StudentGraded` + `StudentFailedCourse`
- `GradeStudent` by wrong teacher → `WrongTeacherError`
- `GradeStudent` by dismissed teacher → `TeacherDismissedError` (BR-E5 second part)
- `GradeStudent` on a closed course → `CourseNotOpenError` (verify grading blocked after `CloseCourse`)
- `CloseCourse` with students still in `'enrolled'` state → `CourseHasActiveEnrollmentsError`
- `CloseCourse` after all students have been graded → `CourseClosed` succeeds (graded students do not block close)
- **Full lifecycle smoke test:** `HireTeacher` → `CreateCourse` → `AssignTeacherToCourse` → `PublishCourse` → `RegisterStudent` → `EnrollStudent` → `GradeStudent` (passing) → assert `StudentPassedCourse` in returned events
- **Re-take test:** fail a course → re-enroll → pass → `reduceStudentCompletedCourses` returns `'passed'`

**`concurrency.test.ts`:**
- Two simultaneous `EnrollStudent` calls for a course with `maxStudents: 1` → `Promise.allSettled` → exactly 1 fulfilled, 1 rejected
- Two simultaneous `HireTeacher` with same email → exactly 1 succeeds
- Two simultaneous `RegisterStudent` with same email → exactly 1 succeeds

#### Acceptance criteria
- [ ] All integration tests pass with `npm run test:integration`
- [ ] Concurrency tests confirm only one winner per locked operation
- [ ] Events table cleared before each test via `beforeEach(clearEvents)`

---

### U-13 — API Server & Routes

**Status:** `pending`
**Claimed by:** —
**Depends on:** U-05, U-06, U-07, U-08, U-09
**Blocks:** nothing

#### Goal
Implement the Fastify HTTP server wiring all command handlers to HTTP routes, plus all `GET` read endpoints.

#### Files to create
- `university-app/src/api/middleware/error-handler.ts`
- `university-app/src/api/routes/teachers.ts`
- `university-app/src/api/routes/courses.ts`
- `university-app/src/api/routes/students.ts`
- `university-app/src/api/server.ts`
- `university-app/src/index.ts`

#### Specification

**`middleware/error-handler.ts`** — Fastify `setErrorHandler`:

| Error type | HTTP status | Response body |
|------------|-------------|---------------|
| `ConcurrencyError` (from `es-dcb-library`) | 409 | `{ error: 'ConcurrencyError', retryable: true, hint: 'Reload and retry' }` |
| `TeacherNotFoundError`, `CourseNotFoundError`, `StudentNotFoundError` | 404 | `{ error: name, message }` |
| Any other domain error | 422 | `{ error: name, message }` |
| Unhandled | 500 | `{ error: 'InternalError', message: 'Internal server error' }` |

**`routes/teachers.ts`** (base path `/api/v1`):
- `POST /teachers` → `hireTeacher` → 201 + `{ teacherId }`
- `POST /teachers/:teacherId/dismiss` → `dismissTeacher` → 201
- `GET /teachers/:teacherId` → load `teacherStream` → `reduceTeacher` → 200; `status === 'none'` → 404

**`routes/courses.ts`**:
- `POST /courses` → `createCourse` → 201 + `{ courseId }`
- `PUT /courses/:courseId/teacher` → `assignTeacher` → 201
- `DELETE /courses/:courseId/teacher` → `removeTeacher` → 200
- `POST /courses/:courseId/publish` → `publishCourse` → 201
- `POST /courses/:courseId/close` → `closeCourse` → 201
- `POST /courses/:courseId/cancel` → `cancelCourse` → 201
- `GET /courses/:courseId` → `reduceCourse` → 200; `status === 'none'` → 404
- `GET /courses/:courseId/enrollments` → Two-pass approach: (1) load `courseEnrollmentStream(courseId)` to discover all unique `studentId`s with a positive net enrollment count; (2) for each, load `enrollmentStream(studentId, courseId)` and run `reduceEnrollment()` to get full status (including graded/passed/failed). Return 200 + `[{ studentId, status, grade? }]`. Ordering: sorted by `studentId` ascending for determinism.
- `POST /courses/:courseId/enrollments` → `enrollStudent` → 201
- `POST /courses/:courseId/enrollments/:studentId/unenroll` → `unenrollStudent` → 201
- `POST /courses/:courseId/enrollments/:studentId/grade` → `gradeStudent` → 201

**`routes/students.ts`**:
- `POST /students` → `registerStudent` → 201 + `{ studentId }`
- `GET /students/:studentId` → load `studentStream(studentId)` → check any `StudentRegistered` event exists → 200 + `{ studentId, name, email, dateOfBirth, registeredAt }`; else 404
- `GET /students/:studentId/courses` → Replay all enrollment events for this student across all courses using an ad-hoc query (not in `streams.ts`):
  ```typescript
  const allStudentEnrollmentEvents = query
    .eventsOfType('StudentEnrolled').where.key('studentId').equals(studentId)
    .eventsOfType('StudentDropped').where.key('studentId').equals(studentId)
    .eventsOfType('StudentWithdrew').where.key('studentId').equals(studentId)
    .eventsOfType('StudentGraded').where.key('studentId').equals(studentId)
    .eventsOfType('StudentPassedCourse').where.key('studentId').equals(studentId)
    .eventsOfType('StudentFailedCourse').where.key('studentId').equals(studentId);
  ```
  Load these events, group by `courseId`, then for each `courseId` call `reduceEnrollment()` on that course's subset of events. Return 200 + `[{ courseId, status, grade?, semester?, creditHours? }]` (include `semester`/`creditHours` from outcome events when available). This is a read-only summary — no additional `enrollmentStream` per course needed since this query already covers all 6 event types filtered by `studentId`.

**`api/server.ts`**:
```typescript
import Fastify from 'fastify';
import type { EventStore } from 'es-dcb-library';
import type { Clock } from '../domain/clock.js';

export function buildServer(store: EventStore, clock: Clock) {
  const app = Fastify({ logger: true });
  // register error handler, register routes
  return app;
}
```

**`src/index.ts`**: reads `DATABASE_URL` (required) and `PORT` (default `3000`) from env; calls `createStore`, `store.initializeSchema()`, `buildServer(store, systemClock)`, starts listening.

#### Acceptance criteria
- [ ] Server starts and all routes are reachable
- [ ] All command endpoints return correct HTTP status codes
- [ ] Error handler maps domain errors to correct status codes
- [ ] GET read endpoints replay events and return correct state
- [ ] `npm run typecheck` passes

---

## Verification

After all tasks are complete:

```bash
cd university-app
npm run typecheck          # zero TypeScript errors
npm run test:unit          # ≥ 45 unit tests, all passing
npm run test:integration   # all command + concurrency integration tests passing
```

**Manual happy-path smoke test** (requires PostgreSQL — set `DATABASE_URL`):
```bash
DATABASE_URL=postgres://user:pass@localhost:5432/university npm start

# 1. Hire a teacher
curl -s -X POST http://localhost:3000/api/v1/teachers \
  -H 'Content-Type: application/json' \
  -d '{"name":"Dr. Smith","email":"smith@uni.edu","department":"CS"}' | jq .

# 2. Create a course
curl -s -X POST http://localhost:3000/api/v1/courses \
  -H 'Content-Type: application/json' \
  -d '{"title":"Intro CS","semester":"Fall 2026","creditHours":3,"maxStudents":30,"prerequisites":[],"dropDeadline":"2026-09-15","withdrawalDeadline":"2026-10-15"}' | jq .

# 3–7. Assign teacher, publish, register student, enroll, grade
# Final assertion:
curl -s http://localhost:3000/api/v1/students/:studentId/courses | jq .
# → course entry with status: 'passed'
```

**Concurrency verification:**
```bash
# Fire two simultaneous enrollment requests for a course with maxStudents: 1
# Expected: exactly one 201, one 409
```
