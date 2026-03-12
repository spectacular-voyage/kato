---
id: adh9kq66dwck6lsariwzdk9
title: 2026 03 12 Replace Test Global Lock
desc: ''
updated: 1773340931828
created: 1773340740342
---

## Goal

Replace the shared test environment lock in `tests/test_env.ts` with explicit
test-state isolation so the root suite can stay deterministic on
Windows/macOS/Linux without serializing unrelated files behind one
process-global lock.

Immediate trigger:

- `runDaemonCli web init fails closed when no password source is configured`
  appears to hang for minutes after earlier tests stall.
- multiple web/runtime tests previously failed at exactly `30s`, matching the
  old lock timeout rather than their own product logic.

## Summary

- The current suite still has broad dependence on process-global environment
  mutation:
  - `HOME`
  - `USERPROFILE`
  - `KATO_RUNTIME_DIR`
  - `KATO_WEB_PASSWORD`
- `tests/test_env.ts` currently protects that shared state with a single
  `.test-tmp/.env-lock` directory. That prevents direct races, but it also
  means one stuck test can block many later tests and make the suite look like
  multiple unrelated timeouts.
- There are currently `68` `withLockedEnvironment(...)` call sites across the
  test tree. That is too much suite surface area to keep behind a single lock
  if we want reliable local runs and future parallelism.
- The right fix is not a more elaborate lock. The right fix is to shrink the
  set of tests that require process-global env at all.
- Production behavior should remain the same:
  - runtime defaults still derive from `HOME` / `USERPROFILE` /
    `KATO_RUNTIME_DIR`
  - `kato web init` may still read `KATO_WEB_PASSWORD`
- The refactor should be additive:
  - keep user-facing contracts unchanged
  - add explicit path/dependency injection points so most tests no longer need
    to mutate process env
  - keep only a small boundary slice that intentionally verifies the default
    env-based behavior

## Discussion

### Current problem shape

The current helper in `tests/test_env.ts` is doing two different jobs:

- serializing tests that mutate process env
- papering over product helpers that do not accept explicit path or dependency
  injection

That coupling is why trivial tests can stall behind each other. For example:

- `tests/web-cli_test.ts` uses `withLockedEnvironment(...)` only to flip
  `KATO_WEB_PASSWORD`
- many loader/auth tests use it only to point default path resolution at a temp
  `HOME`
- command-level tests such as `tests/cli-command-direct_test.ts` take the lock
  for helper setup even when the command path itself is otherwise fully
  injected

The current stale-lock heartbeat workaround is still useful as a stopgap, but
it should be treated as recovery logic, not the final architecture.

### Refactor direction

The suite should move toward three test styles instead of one global lock:

1. Pure injected tests
   - pass explicit stores, dirs, status paths, and password sources
   - no process env mutation
   - safe for module parallelism
2. Filesystem-isolated default-path tests
   - pass explicit `katoDir`, `runtimeDir`, `statusPath`, or config paths into
     loaders/services
   - still touch real files under `.test-tmp`
   - no process env mutation
3. Narrow env-boundary tests
   - intentionally verify `HOME` / `USERPROFILE` / `KATO_RUNTIME_DIR` /
     `KATO_WEB_PASSWORD` fallback behavior
   - kept small, explicit, and serial

### Likely code seams to introduce

The current production code already has some good seams:

- `resolveWebInitPassword(...)` already accepts dependency injection for stdin,
  env, and prompt behavior
- many command handlers already accept injected stores and launchers
- many loaders already accept optional `katoDir` or `statusPath`

The remaining work is to standardize and extend that pattern:

- add explicit path/dependency options where helpers still reach directly into
  default env-based resolvers
- create a reusable test runtime layout helper that derives all expected Kato
  paths under a unique `.test-tmp` root
- make tests prefer explicit paths over temporary `HOME` rewrites

### Candidate migration buckets

#### Bucket 1: web-password-only tests

These are the easiest to remove from the lock first.

Examples:

- `tests/web-cli_test.ts` helpers that wrap `KATO_WEB_PASSWORD`

Preferred direction:

- stop mutating `KATO_WEB_PASSWORD` in most tests
- pass `readPasswordFromEnv`, `readPasswordFromStdin`, and
  `isInteractiveTerminal` test doubles directly to the password resolver or
  command path

#### Bucket 2: default-path loader/auth tests

Examples:

- `tests/web-auth_test.ts`
- `tests/web-log-loader_test.ts`
- `tests/web-server-status_test.ts`
- `tests/web-summary-loader_test.ts`
- `tests/web-session-ingestion_test.ts`

Preferred direction:

- build explicit temp `katoDir` / `runtimeDir`
- pass concrete store paths or `katoDir` options into the loader/service
- reserve env-based tests only for helpers whose purpose is specifically default
  path resolution

#### Bucket 3: command-harness tests

Examples:

- `tests/cli-command-direct_test.ts`
- portions of `tests/web-cli_test.ts`
- portions of `tests/daemon-cli_test.ts`

Preferred direction:

- move temp-dir creation outside env locking
- inject all path-bearing runtime fields directly in the harness
- use env mutation only where the product contract truly depends on process env

### Parallelism policy during the migration

Do not restore root-level `--parallel` immediately.

Recommended sequence:

1. Keep `deno task test` serial while env-coupled tests are being carved out.
2. Reduce `withLockedEnvironment(...)` usage to a small boundary slice.
3. Introduce an explicit parallel-safe slice or restore module parallelism only
   after the env-boundary tests are isolated and measured on Windows.

Windows is exposing the issue more often because filesystem/process scheduling
is less forgiving, but the underlying problem is shared mutable test state, not
a Windows-only product bug.

## Open Issues

- Should the long-term split be:
  - one root `deno task test` that remains serial, plus optional
    `test:parallel-safe`
  - or a composed root flow that runs a parallel-safe slice and then a small
    serial env-boundary slice?
- Do we want a dedicated additive contract such as `ResolvedRuntimePaths` /
  `KatoPathOverrides`, or should each loader/service continue to accept local
  path options independently?
- Which remaining helpers still need direct process-env reads inside production
  code, and which can be moved behind small injectable resolver functions?
- Should `tests/test_env.ts` survive as a narrow env-boundary helper module, or
  should it be deleted entirely once the remaining env tests are rewritten?
- `dev.testing` currently describes root test parallelism as the default. That
  note needs to be reconciled with the current stopgap and the final design.

## Decisions

- Do not restore root-level test parallelism until the env-coupled test surface
  is reduced materially.
- Treat the stale-lock heartbeat cleanup as temporary recovery, not the final
  design.
- Prefer dependency/path injection over stronger global locking.
- Keep user-facing runtime and web-init env contracts unchanged; this refactor
  is about testability and internal seams, not changing CLI behavior.
- Keep a small explicit env-boundary slice so default resolution behavior stays
  covered even after most tests move to injected paths.

## Contract Changes

Expected additive internal contract changes:

- Add a reusable test/runtime layout helper that can derive:
  - `rootDir`
  - `katoDir`
  - `runtimeDir`
  - `statusPath`
  - `controlPath`
  - `webConfigPath`
  - `webStatusPath`
- Add additive path/dependency override options to production helpers that
  currently require process env during tests.
- Standardize password-source injection for web-init tests so they can verify
  env/stdin/prompt precedence without mutating the real process environment.
- Potentially add task-level test split contracts:
  - `test`
  - `test:parallel-safe`
  - `test:env` or equivalent

Non-contract note:

- No user-facing CLI/config schema changes should be required for this refactor.

## Testing

Required coverage for this refactor should include:

- focused regression tests proving the new helper/harness shape works without
  shared env mutation
- focused tests for any new path/dependency override options added to runtime,
  CLI, or web helpers
- explicit boundary tests for:
  - `resolveDefaultRuntimeDir()`
  - `resolveDefaultKatoDir()`
  - `resolveWebInitPassword()` env fallback behavior
- regression coverage that a stale or abandoned env lock no longer blocks the
  general suite, until the lock is fully removed
- verification that migrated tests still exercise real filesystem behavior under
  `.test-tmp`
- local timing/behavior verification on Windows after each migration phase,
  because that is where the current contention has been easiest to reproduce

Validation workflow during the refactor:

- `deno fmt`
- `deno task check`
- focused `deno test` runs for each migrated slice
- `deno task test`

Before closing the task:

- confirm the hanging web-init failure path no longer stalls behind unrelated
  tests
- confirm `withLockedEnvironment(...)` usage is either eliminated or reduced to
  a small intentional boundary slice
- re-measure whether root test parallelism can be restored safely

## Non-Goals

- Do not change the user-facing meaning of `KATO_RUNTIME_DIR`,
  `HOME`/`USERPROFILE`, or `KATO_WEB_PASSWORD`.
- Do not convert all filesystem-backed tests to in-memory stores if the real
  filesystem behavior is part of the contract being tested.
- Do not treat the Deno Windows client-pipe panic as part of this task; that is
  a separate tooling/runtime issue.
- Do not restore root `--parallel` as an optimistic first step.
- Do not hide remaining env coupling under a more complex global lock and call
  the problem solved.

## Implementation Plan

- [ ] Inventory all current `withLockedEnvironment(...)` usages and classify
      them into:
      - `KATO_WEB_PASSWORD` only
      - runtime-path env only
      - mixed env + filesystem default-path tests
      - true env-boundary tests that should remain explicit
- [ ] Introduce a reusable test runtime-layout helper under `tests/` that
      derives explicit Kato paths under a unique `.test-tmp` root and can be
      reused by CLI, runtime, and web tests.
- [ ] Migrate `tests/web-cli_test.ts` away from process-global
      `KATO_WEB_PASSWORD` mutation where possible by using injected password
      sources and terminal doubles.
- [ ] Migrate `tests/cli-command-direct_test.ts` off the shared env lock by
      using explicit temp roots and fully injected command contexts.
- [ ] Audit web loader/auth/status helpers and add additive path/store override
      options where tests currently need to rewrite `HOME`, `USERPROFILE`, or
      `KATO_RUNTIME_DIR`.
- [ ] Migrate the web loader/auth/server-status tests to explicit temp roots and
      explicit path/store injection instead of env mutation.
- [ ] Isolate the true env-boundary behavior into a small dedicated slice that
      intentionally verifies default env resolution semantics.
- [ ] Reduce `tests/test_env.ts` from suite-wide coordination helper to either:
      - a narrow temporary env override helper used only by boundary tests
      - or remove it entirely if the remaining env tests can use simpler local
        helpers
- [ ] Keep root `deno task test` serial until the env-boundary slice is small
      and stable on Windows.
- [ ] After the migration, evaluate a task split such as `test:parallel-safe`
      plus `test:env`, or restore root parallelism only if the combined suite is
      proven stable on Windows.
- [ ] Update `[[dev.testing]]`, `[[dev.general-guidance]]`, and
      `[[dev.decision-log]]` to reflect the final test-isolation model and
      parallelism policy.
