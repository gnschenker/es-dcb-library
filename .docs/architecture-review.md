# Architecture & Tech Stack Review: DCB Event Sourcing Library

*Prepared by: Architecture Expert Agent*
*Date: 2026-02-21*

---

## 1. Tech Stack Recommendation

**Use TypeScript. Full stop.**

For a PostgreSQL-backed event sourcing library targeting Node.js consumers, TypeScript is the correct choice. Here is the reasoning:

**The bottleneck is the database, not the runtime.** This is an I/O-bound workload. Every meaningful operation — appending events, streaming queries, acquiring advisory locks — involves a round-trip to PostgreSQL. The CPU time spent in application code (query building, JSON serialization, result mapping) is dwarfed by network latency and PostgreSQL's own query execution time. For a workload spending 95%+ of wall-clock time waiting on I/O, the language runtime performance differential between TypeScript and Rust is nearly irrelevant.

**The `pg` driver ecosystem is mature and production-hardened.** `node-postgres` (`pg`) has been in production at scale for over a decade. Connection pooling via `pg-pool`, COPY streaming, binary protocol support, and named prepared statements are all available.

**TypeScript gives you the type safety that matters for this domain.** The DCB pattern's core value proposition — dynamically scoped queries with bounded contexts — benefits from a rich type system. You can encode query constraints, event type discrimination, and cursor state into the type system in ways that prevent misuse at the call site.

**The packaging and distribution story is solved.** `tsup` bundles to both ESM and CJS. `vitest` integrates with the same toolchain. No wheel builds, no platform-specific compilation, no binary distribution.

### Specific Technology Choices

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (strict) | Type-safe DSL, primary consumer is Node.js |
| DB driver | `pg` (node-postgres) | Mature, raw SQL control, no ORM abstraction leakage |
| Connection pool | `pg-pool` (bundled with `pg`) | Well-tested, configure `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` explicitly |
| Streaming | `AsyncGenerator<Event>` over keyset pagination | Clean `for await` interface, no long-lived transactions |
| Concurrency | `pg_try_advisory_xact_lock` | Per-stream serialization without serializable isolation overhead |
| Testing (unit) | `vitest` | Same toolchain as build, fast, ESM-native |
| Testing (integration) | `testcontainers-node` | Disposable real PostgreSQL instances per suite |
| Bundling | `tsup` | ESM + CJS dual output, type declarations, `exports` field |

---

## 2. TypeScript Evaluation

### Strengths for This Use Case

**Type-safe query DSL construction.** TypeScript's template literal types, discriminated unions, and conditional types let you build a query DSL where invalid queries are compile-time errors, not runtime exceptions. You can express "a query must have at least one criterion" in the type system. This is genuinely hard to achieve in Python or Go.

**Async/await + streams are first-class.** The DCB streaming requirement maps cleanly onto Node.js's `AsyncIterable` interface. Keyset-pagination streaming implemented as an `AsyncGenerator` is idiomatic, composable, and integrates with any consumer that understands async iteration. Backpressure comes for free through the generator protocol.

**Testing infrastructure is excellent.** `vitest` supports in-process mocking of the `pg` client; `testcontainers-node` gives disposable PostgreSQL instances per test suite.

**Zero cross-language friction for the primary consumer.** Full type definitions, tree-shaking, ESM/CJS compatibility, no native bindings.

### Weaknesses and Risks

**Memory pressure under high-volume streaming.** Node.js's garbage collector can struggle with high-throughput streaming of large event payloads. Mitigation: implement proper backpressure, avoid materializing entire result sets, consume row-by-row.

**No true parallelism for CPU-bound work.** JSON serialization of large event payloads is single-threaded. Mitigation: `worker_threads` for offloading, or accepting that this is not a CPU-bound workload in normal usage.

**Type system limits for complex DSL encoding.** Deeply nested conditional types hit compiler performance walls. Budget time for type-level engineering if the DSL grows complex.

**`pg` driver quirks.** Known footguns: connection pool exhaustion on unhandled promise rejections, implicit transaction behavior differences. Require defensive coding conventions.

---

## 3. Rust / C Analysis

### Performance Gains: Honest Assessment

For this specific workload, the concrete numbers are:

| Operation | TypeScript (V8) | Rust | Delta |
|---|---|---|---|
| JSON serialize/deserialize | ~150 MB/s | ~400–600 MB/s | 2–4× |
| Advisory lock acquire | ~1–10 ms (DB round-trip) | ~1–10 ms (DB round-trip) | ~0 |
| Streaming throughput (100K events/s) | GC pauses possible | Predictable | Measurable at extreme scale |
| Connection pool management | Mature, GC-managed | Deterministic, zero-GC | Negligible in practice |

**Verdict:** The JSON delta is invisible behind PostgreSQL latency (1–10 ms per query). At typical event sourcing workloads (hundreds to low thousands of events/second), TypeScript is entirely adequate. Rust becomes compelling only at very high streaming throughput (>100K events/second) with large payloads.

### Cross-Language FFI: Java 21+

**Project Panama / Foreign Function & Memory API (GA in Java 22):** The modern answer — no JNI boilerplate, `jextract` generates Java bindings from C headers automatically.

**However, the gotchas for a database library are severe:**

- Connection pool state and async runtime (tokio) do not cross FFI boundaries cleanly. You need explicit C-compatible synchronous wrappers around async Rust code.
- Memory ownership across the FFI boundary requires careful lifecycle management. Rust's ownership model does not map to Java's GC.
- Exception/error propagation across FFI is painful. PostgreSQL errors need to be serialized to C-compatible error codes and re-raised as Java exceptions.
- If your Rust library uses `tokio-postgres`, you need a dedicated tokio runtime thread and explicit `block_on` calls, defeating much of the performance advantage.

**Realistic estimate:** Getting a Rust event store library working correctly from Java requires a dedicated Java wrapper library — 3–6 months of engineering work beyond the core library.

**JNI:** More mature than Panama but requires C++ glue code that is verbose, error-prone, and hard to debug. Not recommended for new projects.

### Cross-Language FFI: Python 3.x

**PyO3 (Rust → Python):** The mature, modern answer. PyO3 0.20+ supports stable ABI; `maturin` makes building and publishing wheels relatively straightforward (`manylinux_2_28` wheels via `maturin` + GitHub Actions).

**Caveats:**

- The async story is complicated. Python's `asyncio` and Rust's `tokio` have different event loop models. `pyo3-asyncio` bridges them but has had stability issues. For a database I/O library, this is a significant concern.
- Wheel distribution requires building for multiple platforms (linux x86_64, linux aarch64, macOS arm64, macOS x86_64, Windows). Automatable with CI but adds ongoing maintenance burden.
- PyO3 is battle-tested for CPU-bound extensions. For async I/O libraries, the integration story is messier.

**ctypes/cffi:** Work for simple C interfaces. For anything with complex async semantics or rich types, painful to use correctly.

### Cross-Language FFI: Node.js

**Neon (Rust → Node.js):** Neon 1.0+ uses N-API (stable ABI across Node.js versions). Async support has improved with `JoinHandle`-based async.

**Caveats:**

- You are replacing `node-postgres` (pure JS, excellent ergonomics) with a native module. Consumers need a C++ toolchain (`node-gyp`) or you pre-build and distribute platform-specific binaries via `optionalDependencies`.
- Requires bridging tokio's runtime with Node.js's libuv event loop.
- For a library that is primarily making PostgreSQL network calls, you are adding substantial complexity for negligible performance gain.

### Bottom Line on Rust/C

> The performance gains do not justify the cross-language complexity for a database I/O-bound library. You would spend 60% of engineering time on FFI plumbing, error propagation, async runtime bridging, and binary distribution — none of which delivers user-visible features.

The only scenario where native code becomes compelling is if the event store library does significant in-process computation: complex projection, in-memory state aggregation, or cryptographic operations on event payloads.

---

## 4. Hybrid Approaches

### Rust Core + Language-Specific Thin Wrappers

**When it makes sense:** If you have a battle-tested TypeScript implementation and need to expand to Java and Python simultaneously, extracting a Rust core with a C API and building PyO3 + JNI wrappers is a viable long-term architecture (this is what DuckDB does).

**When it does not make sense:** For an MVP targeting primarily Node.js. The upfront investment is substantial and only pays off at scale with multiple language targets.

### HTTP Microservice / Sidecar

**Wrong abstraction for this library.** An event store sidecar:
- Introduces network overhead on every append and query
- Adds operational complexity
- Eliminates the ability to participate in the consumer's database transactions

Transactional append with optimistic concurrency — a core DCB requirement — becomes very hard to implement correctly across an HTTP boundary. **Do not do this.**

### gRPC / Protocol Buffers

Same fundamental problem as the HTTP sidecar. Transactional participation across a gRPC boundary is not cleanly achievable. gRPC makes sense for remote event stores (like EventStoreDB's gRPC client), but not for a library that needs to share transactions with the consumer.

### WebAssembly (WASM)

Technically interesting, practically limited. WASM cannot make direct TCP connections — it cannot connect to PostgreSQL. You would still need a host-side database driver. **Not viable for this use case.**

---

## 5. Final Verdict

### MVP: TypeScript on Node.js

The reasoning is unambiguous:

1. The primary consumer is Node.js — TypeScript provides the best integration story with zero friction
2. The workload is I/O-bound — TypeScript's performance characteristics are entirely adequate
3. The ecosystem (`pg`, `testcontainers-node`, `vitest`, `tsup`) covers all requirements with mature, maintained tools
4. You ship faster and can iterate on the DCB query DSL API design without fighting cross-language type mapping

### Migration / Expansion Path for Java and Python

**If cross-language support becomes a genuine requirement:**

1. **Stabilize the TypeScript API first.** Get the DCB query DSL right. Get the concurrency semantics right. Do not attempt cross-language work until the API is stable — FFI bindings are expensive to change.

2. **For Java:** Implement a dedicated Java library using `pgjdbc` (the mature PostgreSQL JDBC driver) and port the query DSL logic. Do **not** FFI into the TypeScript or Rust implementation. The Java ecosystem has first-class PostgreSQL support and you will get a better result with a native implementation. Share the DCB pattern specification (documented as an ADR or RFC) as the shared artifact.

3. **For Python:** Same approach — implement natively using `asyncpg` (significantly faster than `psycopg2` for async workloads) or `psycopg3`. Share the specification, not the code.

4. **Do not build a Rust core with FFI wrappers** unless benchmarking reveals a specific, measured performance gap that cannot be addressed by query optimization or connection tuning.

### What NOT to Do

| Anti-pattern | Reason |
|---|---|
| Rust/C native module for Node.js | Months of FFI work for unmeasurable gain on a DB I/O-bound library |
| HTTP sidecar / gRPC | Loses transaction participation; violates the core advisory lock contract |
| ORM | Abstraction leakage; makes keyset-pagination awkward; obscures the SQL |
| Bun/Deno as primary runtime | `pg` compatibility edge cases; validate on Node.js first |
| Shared native core with FFI for Java/Python | Implement natively per language; share the spec, not the binary |

### Summary

> TypeScript on Node.js with `pg` is the correct choice for this library at this stage. It matches the consumer ecosystem, the tooling is mature, and the I/O-bound workload means language performance is not the variable that matters. If cross-language support is needed later, implement natively in each target language using the DCB specification as the shared artifact — not FFI into a shared native core.
