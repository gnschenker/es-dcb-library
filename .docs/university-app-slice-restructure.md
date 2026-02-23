# University App — Vertical Slice Restructure Plan

## Context

The current university-app uses **horizontal layering**: commands are in `src/commands/`, routes in `src/api/routes/`, the projection in `src/projections/`, and tests in a top-level `tests/` directory split by type (unit/integration). Tracing a single feature (e.g., "hire a teacher") requires visiting four separate directories.

The goal is to reorganize so that every file contributing to a slice lives in one place. The target is **one file per feature** — each file owns its Fastify route registration, command handler, private query builders, and state reducer. Tests live in a file alongside it.

### Process naming rationale

Folder names follow industry-standard higher-education process terminology (sourced from PeopleSoft Campus Solutions, SAP Student Lifecycle Management, Workday Student, HERM/EDUCAUSE, and AACRAO):

| Process folder | Industry term origin | Commands it owns |
|---|---|---|
| `academic-staffing` | "Academic Staff Management" (HERM/UCISA); "Academic Workforce Management" (SAP community) | hire-teacher, dismiss-teacher, assign-teacher, remove-teacher |
| `curriculum-management` | "Curriculum Management" (PeopleSoft official module); Gartner market category | create-course, publish-course, close-course, cancel-course |
| `student-lifecycle` | "Student Lifecycle Management" (SAP SLCM); "Student Lifecycle" (Workday Student) | register-student, enroll-student, unenroll-student, grade-student |

> **Note on assign/remove teacher:** Assigning a teacher to a course is placed in `academic-staffing` because the operation is **teacher-state-driven** — the teacher must be `hired` before assignment is allowed, and `DismissTeacher` automatically removes draft-course assignments.

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
│   └── features/                             # Vertical slices — one folder per business process
│       │
│       ├── academic-staffing/                # Managing teaching staff at the university
│       │   ├── hire-teacher.ts               # Route + command + handler (self-contained slice)
│       │   ├── hire-teacher.test.ts
│       │   ├── dismiss-teacher.ts
│       │   ├── dismiss-teacher.test.ts
│       │   ├── assign-teacher.ts
│       │   ├── assign-teacher.test.ts
│       │   ├── remove-teacher.ts
│       │   ├── remove-teacher.test.ts
│       │   ├── read-model.ts                 # Teachers projection (shared within this process)
│       │   └── read-model.test.ts
│       │
│       ├── curriculum-management/            # Designing, publishing and archiving courses
│       │   ├── create-course.ts
│       │   ├── create-course.test.ts
│       │   ├── publish-course.ts
│       │   ├── publish-course.test.ts
│       │   ├── close-course.ts
│       │   ├── close-course.test.ts
│       │   ├── cancel-course.ts
│       │   └── cancel-course.test.ts
│       │
│       └── student-lifecycle/                # Student registration, enrolment and academic progress
│           ├── register-student.ts
│           ├── register-student.test.ts
│           ├── enroll-student.ts
│           ├── enroll-student.test.ts
│           ├── unenroll-student.ts
│           ├── unenroll-student.test.ts
│           ├── grade-student.ts
│           ├── grade-student.test.ts
│           └── concurrency.test.ts           # Cross-feature concurrency scenario
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
// e.g. src/features/academic-staffing/hire-teacher.ts

// 1. Private query builder (never exported — only used in this file)
function teacherStream(teacherId: string) { ... }

// 2. State type + reducer (exported for tests; never imported by other slices)
export type TeacherHireState = { status: 'none' | 'hired' | 'dismissed'; ... }
export function reduceTeacher(events: StoredEvent[]): TeacherHireState { ... }

// 3. Command handler
export async function hireTeacher(store: EventStore, clock: Clock, input: HireTeacherInput) { ... }

// 4. Fastify route registration (exported for server.ts to register)
export const hireTeacherRoute: FastifyPluginAsync<{ store: EventStore; clock: Clock }> =
  async (app, { store, clock }) => {
    app.post('/api/v1/teachers', async (req, reply) => {
      const result = await hireTeacher(store, clock, req.body as HireTeacherInput);
      reply.code(201).send(result);
    });
  };
```

`server.ts` imports and registers each route plugin — it becomes the single place that wires HTTP to features, but contains no business logic:

```typescript
// src/api/server.ts (excerpt)
import { hireTeacherRoute }    from '../features/academic-staffing/hire-teacher.js';
import { dismissTeacherRoute } from '../features/academic-staffing/dismiss-teacher.js';
// ...
await app.register(hireTeacherRoute,    { store, clock });
await app.register(dismissTeacherRoute, { store, clock });
```

---

## File Moves

### Commands + Routes merged: `src/commands/` + `src/api/routes/` → single file per feature

| Old files | New single file |
|---|---|
| `src/commands/hire-teacher.ts` + hire route from `src/api/routes/teachers.ts` | `src/features/academic-staffing/hire-teacher.ts` |
| `src/commands/dismiss-teacher.ts` + dismiss route from `src/api/routes/teachers.ts` | `src/features/academic-staffing/dismiss-teacher.ts` |
| `src/commands/assign-teacher.ts` + assign route from `src/api/routes/teachers.ts` | `src/features/academic-staffing/assign-teacher.ts` |
| `src/commands/remove-teacher.ts` + remove route from `src/api/routes/teachers.ts` | `src/features/academic-staffing/remove-teacher.ts` |
| `src/commands/create-course.ts` + create route from `src/api/routes/courses.ts` | `src/features/curriculum-management/create-course.ts` |
| `src/commands/publish-course.ts` + publish route from `src/api/routes/courses.ts` | `src/features/curriculum-management/publish-course.ts` |
| `src/commands/close-course.ts` + close route from `src/api/routes/courses.ts` | `src/features/curriculum-management/close-course.ts` |
| `src/commands/cancel-course.ts` + cancel route from `src/api/routes/courses.ts` | `src/features/curriculum-management/cancel-course.ts` |
| `src/commands/register-student.ts` + register route from `src/api/routes/students.ts` | `src/features/student-lifecycle/register-student.ts` |
| `src/commands/enroll-student.ts` + enroll route from `src/api/routes/courses.ts` | `src/features/student-lifecycle/enroll-student.ts` |
| `src/commands/unenroll-student.ts` + unenroll route from `src/api/routes/courses.ts` | `src/features/student-lifecycle/unenroll-student.ts` |
| `src/commands/grade-student.ts` + grade route from `src/api/routes/courses.ts` | `src/features/student-lifecycle/grade-student.ts` |

### Read endpoints (GET routes)

The existing GET routes in `teachers.ts`, `students.ts`, and `courses.ts` replay events to return current state. Each belongs with the process it reads from:

| Old GET route | New home |
|---|---|
| `GET /teachers/:teacherId` | `src/features/academic-staffing/hire-teacher.ts` (or a dedicated `get-teacher.ts` if preferred) |
| `GET /students/:studentId` | `src/features/student-lifecycle/register-student.ts` |
| `GET /students/:studentId/courses` | `src/features/student-lifecycle/register-student.ts` |
| `GET /courses/:courseId` | `src/features/curriculum-management/create-course.ts` |
| `GET /courses/:courseId/enrollments` | `src/features/student-lifecycle/enroll-student.ts` |

> Read endpoints that are pure projections of a single entity's state naturally co-locate with the command that creates that entity. If a read endpoint grows complex enough to warrant its own file, it can be extracted as `get-teacher.ts` etc.

### Projection: `src/projections/` → `src/features/academic-staffing/read-model.ts`

| Old path | New path |
|---|---|
| `src/projections/teachers-read-model.ts` | `src/features/academic-staffing/read-model.ts` |

### Tests: one test file per feature file

| Old path | New path |
|---|---|
| `tests/unit/teacher-commands.test.ts` | split: one `.test.ts` per command in `academic-staffing/` |
| `tests/unit/course-commands.test.ts` | split: one `.test.ts` per command in `curriculum-management/` |
| `tests/unit/enrollment-commands.test.ts` | split: one `.test.ts` per command in `student-lifecycle/` |
| `tests/integration/teachers.test.ts` | merged into per-command test files in `academic-staffing/` |
| `tests/integration/courses.test.ts` | merged into per-command test files in `curriculum-management/` |
| `tests/integration/students.test.ts` | merged into per-command test files in `student-lifecycle/` |
| `tests/integration/enrollments.test.ts` | merged into per-command test files in `student-lifecycle/` |
| `tests/integration/concurrency.test.ts` | `src/features/student-lifecycle/concurrency.test.ts` |

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
2. **Process-navigable**: `src/features/student-lifecycle/` shows every command, route, and test for the student journey
3. **Business language in the folder structure**: `academic-staffing`, `curriculum-management`, `student-lifecycle` reflect how the university domain operates
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
