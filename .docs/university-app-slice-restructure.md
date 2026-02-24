# University App — Vertical Slice Restructure Plan

## Context

The current university-app uses **horizontal layering**: commands are in `src/commands/`, routes in `src/api/routes/`, the projection in `src/projections/`, and tests in a top-level `tests/` directory split by type (unit/integration). Tracing a single feature (e.g., "hire a teacher") requires visiting four separate directories.

The goal is to reorganize so that every file contributing to a slice lives in one place. The target is **one file per feature** — each file owns its Fastify route registration, command handler, private query builders, and state reducer. Tests live in a file alongside it.

### Folder naming

The implementation uses simple, direct domain names for the feature folders:

| Folder | Commands it owns |
|---|---|
| `teachers` | hire-teacher, dismiss-teacher, assign-teacher, remove-teacher |
| `courses` | create-course, publish-course, close-course, cancel-course |
| `students` | register-student |
| `enrollments` | enroll-student, unenroll-student, grade-student |

> **Note on assign/remove teacher:** Assigning a teacher to a course belongs in the `teachers` slice because the operation is **teacher-state-driven** — the teacher must be `hired` before assignment is allowed, and `DismissTeacher` checks active course assignments. The `PUT /courses/:courseId/teacher` and `DELETE /courses/:courseId/teacher` routes are registered in `teachers/routes.ts`, not `courses/routes.ts`.

> **Previous plan:** An earlier draft of this document proposed `academic-staffing`, `curriculum-management`, and `student-lifecycle` as folder names. The implementation chose the simpler direct names above.

---

## Proposed Directory Structure

```
university-app/
├── src/
│   ├── index.ts                              # Server startup + projection wiring (unchanged)
│   ├── store.ts                              # EventStore factory — shared infra (unchanged)
│   │
│   ├── domain/                               # Shared inter-slice contracts only
│   │   ├── events.ts                         # Event payload types (the only cross-slice import)
│   │   ├── errors.ts                         # Domain error classes
│   │   ├── ids.ts                            # Deterministic ID generators
│   │   └── clock.ts                          # Clock interface + systemClock
│   │
│   ├── api/                                  # HTTP infrastructure only (no business logic)
│   │   ├── server.ts                         # Fastify app builder — registers routes from features
│   │   └── middleware/
│   │       └── error-handler.ts              # Domain error → HTTP status mapping
│   │
│   └── features/                             # Vertical slices — one folder per business domain
│       │
│       ├── teachers/                         # Teaching staff management
│       │   ├── hire-teacher.ts               # Command handler (self-contained slice)
│       │   ├── dismiss-teacher.ts
│       │   ├── assign-teacher.ts             # Also owns PUT/DELETE /courses/:id/teacher routes
│       │   ├── remove-teacher.ts
│       │   ├── read-model.ts                 # Teachers projection
│       │   ├── routes.ts                     # All teacher + course-teacher-assignment routes
│       │   └── tests/
│       │       ├── teacher-commands.unit.test.ts
│       │       └── teachers.integration.test.ts
│       │
│       ├── courses/                          # Course lifecycle
│       │   ├── create-course.ts
│       │   ├── publish-course.ts
│       │   ├── close-course.ts
│       │   ├── cancel-course.ts
│       │   ├── routes.ts
│       │   └── tests/
│       │       ├── course-commands.unit.test.ts
│       │       └── courses.integration.test.ts
│       │
│       ├── students/                         # Student registration
│       │   ├── register-student.ts
│       │   ├── routes.ts
│       │   └── tests/
│       │       └── students.integration.test.ts
│       │
│       └── enrollments/                      # Student enrolment and academic progress
│           ├── enroll-student.ts
│           ├── unenroll-student.ts
│           ├── grade-student.ts
│           ├── routes.ts
│           └── tests/
│               ├── enrollment-commands.unit.test.ts
│               ├── enrollments.integration.test.ts
│               └── concurrency.integration.test.ts
│
└── tests/
    └── integration/
        ├── setup.ts                          # PostgreSQL testcontainer — shared infra
        └── container-setup.ts               # Vitest per-worker setup — shared infra
```

---

## What Each Feature File Contains

Every `<feature>.ts` file is fully self-contained and owns four things:

```typescript
// e.g. src/features/teachers/hire-teacher.ts

// 1. Private query builder (never exported — only used in this file)
function teacherStream(teacherId: string) { ... }

// 2. State type + reducer (exported for tests; never imported by other slices)
export type TeacherHireState = { status: 'none' | 'hired' | 'dismissed'; ... }
export function reduceTeacher(events: StoredEvent[]): TeacherHireState { ... }

// 3. Command handler
export async function hireTeacher(store: EventStore, clock: Clock, input: HireTeacherInput) { ... }
```

Routes for a domain are collected in a `routes.ts` file per slice folder and registered by `server.ts`:

```typescript
// src/features/teachers/routes.ts
export async function registerTeacherRoutes(app, store, clock, readPool?) {
  app.post('/teachers', ...);       // hire
  app.post('/teachers/:id/dismiss', ...); // dismiss
  app.put('/courses/:id/teacher', ...);   // assign (teacher-state-driven)
  app.delete('/courses/:id/teacher', ...); // remove
  app.get('/teachers/:id', ...);    // read
}
```

`server.ts` imports and registers each route plugin — it becomes the single place that wires HTTP to features, but contains no business logic:

```typescript
// src/api/server.ts (excerpt)
import { registerTeacherRoutes }    from '../features/teachers/routes.js';
import { registerCourseRoutes }     from '../features/courses/routes.js';
// ...
await registerTeacherRoutes(app, store, clock, readPool);
await registerCourseRoutes(app, store, clock);
```

---

## File Moves

### Commands + Routes merged: `src/commands/` + `src/api/routes/` → single file per feature

| Old files | New single file |
|---|---|
| `src/commands/hire-teacher.ts` | `src/features/teachers/hire-teacher.ts` |
| `src/commands/dismiss-teacher.ts` | `src/features/teachers/dismiss-teacher.ts` |
| `src/commands/assign-teacher.ts` | `src/features/teachers/assign-teacher.ts` |
| `src/commands/remove-teacher.ts` | `src/features/teachers/remove-teacher.ts` |
| `src/api/routes/teachers.ts` (+ assign/remove routes) | `src/features/teachers/routes.ts` |
| `src/commands/create-course.ts` | `src/features/courses/create-course.ts` |
| `src/commands/publish-course.ts` | `src/features/courses/publish-course.ts` |
| `src/commands/close-course.ts` | `src/features/courses/close-course.ts` |
| `src/commands/cancel-course.ts` | `src/features/courses/cancel-course.ts` |
| `src/api/routes/courses.ts` (course lifecycle routes) | `src/features/courses/routes.ts` |
| `src/commands/register-student.ts` | `src/features/students/register-student.ts` |
| `src/api/routes/students.ts` | `src/features/students/routes.ts` |
| `src/commands/enroll-student.ts` | `src/features/enrollments/enroll-student.ts` |
| `src/commands/unenroll-student.ts` | `src/features/enrollments/unenroll-student.ts` |
| `src/commands/grade-student.ts` | `src/features/enrollments/grade-student.ts` |
| `src/api/routes/courses.ts` (enrollment routes) | `src/features/enrollments/routes.ts` |

### Read endpoints (GET routes)

The existing GET routes in `teachers.ts`, `students.ts`, and `courses.ts` replay events to return current state. Each belongs with the process it reads from:

| Old GET route | New home |
|---|---|
| `GET /teachers/:teacherId` | `src/features/teachers/routes.ts` |
| `GET /students/:studentId` | `src/features/students/routes.ts` |
| `GET /students/:studentId/courses` | `src/features/students/routes.ts` |
| `GET /courses/:courseId` | `src/features/courses/routes.ts` |
| `GET /courses/:courseId/enrollments` | `src/features/enrollments/routes.ts` |

> Read endpoints that are pure projections of a single entity's state naturally co-locate with the command that creates that entity. If a read endpoint grows complex enough to warrant its own file, it can be extracted as `get-teacher.ts` etc.

### Projection: `src/projections/` → `src/features/teachers/read-model.ts`

| Old path | New path |
|---|---|
| `src/projections/teachers-read-model.ts` | `src/features/teachers/read-model.ts` |

### Tests: one test file per feature file

| Old path | New path |
|---|---|
| `tests/unit/teacher-commands.test.ts` | `src/features/teachers/tests/teacher-commands.unit.test.ts` |
| `tests/unit/course-commands.test.ts` | `src/features/courses/tests/course-commands.unit.test.ts` |
| `tests/unit/enrollment-commands.test.ts` | `src/features/enrollments/tests/enrollment-commands.unit.test.ts` |
| `tests/integration/teachers.test.ts` | `src/features/teachers/tests/teachers.integration.test.ts` |
| `tests/integration/courses.test.ts` | `src/features/courses/tests/courses.integration.test.ts` |
| `tests/integration/students.test.ts` | `src/features/students/tests/students.integration.test.ts` |
| `tests/integration/enrollments.test.ts` | `src/features/enrollments/tests/enrollments.integration.test.ts` |
| `tests/integration/concurrency.test.ts` | `src/features/enrollments/tests/concurrency.integration.test.ts` |

Domain-level tests (`tests/unit/domain-errors.test.ts`, `tests/unit/domain-ids.test.ts`) test shared utilities not belonging to any slice — move to `src/domain/tests/` or keep in `tests/unit/`.

---

## `vitest.config.ts` Updates

Tests now live inside `src/features/`. Since all test files use the `.test.ts` suffix (both unit and integration tests co-locate with their feature), the vitest projects need to distinguish them by a different marker. Options:

**Option 1 — Suffix convention** (`.unit.test.ts` / `.integration.test.ts`):
```typescript
// unit project
include: ['src/**/*.unit.test.ts', 'tests/unit/**/*.test.ts']
// integration project
include: ['src/**/*.integration.test.ts', 'tests/integration/**/*.test.ts']
```

**Option 2 — Single `.test.ts` per feature, vitest project filter by folder** (simpler, since unit and integration tests are already in separate files by feature):
```typescript
// unit project: all test files, but with no DB setup — unit tests must not use the DB
include: ['src/features/**/*.test.ts', 'tests/unit/**/*.test.ts']
// integration project: only the integration-specific tests
include: ['src/features/**/concurrency.test.ts', 'tests/integration/**/*.test.ts']
```

Option 1 is more explicit. Recommend using `.unit.test.ts` / `.integration.test.ts` suffixes for all co-located tests.

---

## What Does NOT Change

| Item | Reason |
|---|---|
| `src/domain/` | Shared contracts — correct as-is |
| `src/store.ts` | Shared infrastructure |
| `src/index.ts` | Server entry point (only import paths inside it change) |
| `src/api/server.ts` | Stays in `api/`; becomes a pure route-wiring file |
| `src/api/middleware/error-handler.ts` | Shared HTTP infrastructure |
| All business logic | No logic changes — file moves, route merges, and import path updates only |
| `tests/integration/setup.ts` | Shared test infra |
| `tests/integration/container-setup.ts` | Shared test infra |

---

## Benefits

1. **One file per feature**: opening `hire-teacher.ts` shows everything needed to understand and change that use case — the HTTP contract, the business rules, the event-store interaction
2. **Domain-navigable**: `src/features/enrollments/` shows every command, route, and test for the student enrolment journey
3. **Direct domain language in the folder structure**: `teachers`, `courses`, `students`, `enrollments` map 1:1 to the domain concepts
4. **Co-located tests**: the test file for a feature is right next to its implementation
5. **Slice boundaries visible in imports**: a cross-process import is immediately suspicious and easy to spot in code review

---

## Verification

After restructuring, all checks must remain green with no logic changes:

```bash
# From university-app/
npm run typecheck        # All import paths must resolve — catches any missed path update
npm run test:unit        # All unit tests pass
npm run test:integration # All integration tests pass (requires Docker)
npm run build            # Build succeeds
```
