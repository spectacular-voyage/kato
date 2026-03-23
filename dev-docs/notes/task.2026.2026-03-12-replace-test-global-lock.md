---
id: adh9kq66dwck6lsariwzdk9
title: 2026 03 12 Replace Test Global Lock
desc: ''
updated: 1773340931828
created: 1773340740342
---

## Goal

Support `deno test --parallel` for as much of the root suite as possible by
replacing the shared test environment lock in `tests/test_env.ts` with explicit
test-state isolation and by confining true process-env contract coverage to a
small, intentional serial slice.

Immediate trigger:

- `runDaemonCli web init fails closed when no password source is configured`
  appears to hang for minutes after earlier tests stall.
- multiple web/runtime tests previously failed at exactly `30s`, matching the
  old lock timeout rather than their own product logic.
- the shared filesystem env lock has now been removed, and the remaining
  env-boundary tests are intentionally routed through a serial root slice.

## Summary

- The current suite still has broad dependence on process-global environment
  mutation:
  - `HOME`
  - `USERPROFILE`
  - `KATO_RUNTIME_DIR`
  - `KATO_WEB_PASSWORD`
  - `KATO_DAEMON_STATUS_PATH`
  - `KATO_DAEMON_CONTROL_PATH`
  - `KATO_ALLOWED_WRITE_ROOT`
  - `KATO_ALLOWED_WRITE_ROOTS_JSON`
  - provider-root / config / logging env overrides exercised in runtime-config
    tests
- `tests/test_env.ts` no longer coordinates the suite through
  `.test-tmp/.env-lock`. It now snapshots and restores the bounded env keys
  allowed by the serial env slice.
- The refreshed inventory is now:
  - `0` `withLockedEnvironment(...)` call sites
  - `30` `withIsolatedEnvironment(...)` call sites across `11` test files
- Most lock usage is not equally hard:
  - accidental lock-only usage has been removed from the suite
  - `28` call sites are true env-boundary coverage that intentionally remain
    serial
  - `2` call sites are helper self-tests
- The right fix was not a more elaborate lock. The right fix was to shrink the
  set of tests that require process-global env at all, split the root suite
  explicitly, and make `deno test --parallel` viable for the broad
  parallel-safe slice.
- The higher-level web/runtime tests that previously rewrote `HOME` for default
  path resolution now use explicit temp roots and additive entry-point seams.
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
- Prefer reusing existing `katoDir` / `runtimeDir` / `statusPath` / store /
  logger injection seams before adding new abstractions.

## Discussion

### Current problem shape

The current helper in `tests/test_env.ts` is doing two different jobs:

- serializing tests that mutate process env
- papering over product helpers that do not accept explicit path or dependency
  injection

That coupling is why trivial tests could stall behind each other. For example:

- `tests/web-cli_test.ts` uses `withLockedEnvironment(...)` only to flip
  `KATO_WEB_PASSWORD`
- many loader/auth tests use it only to point default path resolution at a temp
  `HOME`
- command-level tests such as `tests/cli-command-direct_test.ts` take the lock
  for helper setup even when the command path itself is otherwise fully
  injected

That stale-lock heartbeat workaround has now been retired along with the shared
filesystem lock.

### Refreshed inventory snapshot (2026-03-18, after env/task split batch)

- `0` accidental lock-only uses remain
- `28` true env-boundary uses remain:
  - `tests/daemon-control-plane_test.ts` (`8`)
  - `tests/runtime-config_test.ts` (`7`)
  - `tests/path-policy_test.ts` (`3`)
  - `tests/daemon-cli_test.ts` (`3`)
  - `tests/daemon-launcher_test.ts` (`2`)
  - `tests/daemon-main_test.ts` (`1`)
  - `tests/runtime-env_test.ts` (`1`)
  - `tests/executable-resolution_test.ts` (`1`)
  - `tests/participant-username-resolver_test.ts` (`1`)
  - `tests/web-cli_test.ts` (`1`)
- `0` remaining default-path/filesystem uses remain
- `2` helper self-test uses remain:
  - `tests/test_env_test.ts` (`2`)
- `0` shared `.env-lock` uses remain

Completed in this batch:

- `apps/web/src/auth.ts`
- `apps/web/src/logging.ts`
- `apps/web/src/recordings_page_post.ts`
- `apps/web/src/server_status.ts`
- `apps/web/src/live_routes.ts`
- `tests/web-auth_test.ts`
- `tests/web-recordings-page-post_test.ts`
- `tests/web-server-status_test.ts`
- `tests/web-live-routes_test.ts`
- `tests/web-logging_test.ts`
- `tests/test_env.ts`
- `tests/test_env_test.ts`
- `scripts/run-root-test-slices.ts`
- `deno.json` root test-task split
- `tests/web-session-actions_test.ts`
- `tests/web-summary-loader_test.ts`
- `tests/web-log-loader_test.ts`
- `tests/web-activity-loader_test.ts`

### Top-level seam wave status

The large "existing-override" bucket is complete, and the remaining
top-level seam wave is also complete. There are no remaining default-path web
tests that depend on `HOME` rewriting just to reach temp roots.

### Parallelism target and task shape

`deno.json` now reflects the split test model explicitly:

- `test:parallel-safe` runs `deno test --parallel` across the broad suite with
  the env-boundary files excluded
- `test:env` runs the remaining env-boundary files serially
- `test` and `test:coverage` dispatch those two slices sequentially via
  `scripts/run-root-test-slices.ts`

That means broad `deno test --parallel` support now exists for the intended
parallel-safe slice, while the remaining env-contract tests stay explicit and
serial by design.

### Candidate migration buckets

#### Bucket 0: accidental lock usage

This first cleanup step is complete.

Preferred direction:

- keep it removed
- continue using `tests/test_temp.ts` for temp-dir isolation only

#### Bucket 1: web-password-only tests

This first migration step is mostly complete. Command-level web-init tests now
use injected password sources, and the remaining lock usage in
`tests/web-cli_test.ts` is the intentional env-boundary test for actual
`KATO_WEB_PASSWORD` fallback behavior.

- `tests/web-cli_test.ts`

Preferred direction:

- keep the tiny serial env-fallback test for `KATO_WEB_PASSWORD`
- keep broader command coverage on injected password-source seams

#### Bucket 2: existing-override filesystem tests

This bucket is now complete. These cases had enough product seams to move off
`HOME` rewrites mostly by rewriting the tests and threading explicit temp-root
paths.

Examples:

- `tests/user-settings_test.ts`
- `tests/workspace-mutations_test.ts`
- `tests/web-session-ingestion_test.ts`
- `tests/web-session-actions_test.ts`
- `tests/web-summary-loader_test.ts`
- `tests/web-log-loader_test.ts`
- `tests/web-activity-loader_test.ts`

Preferred direction:

- build explicit temp `katoDir` / `runtimeDir`
- pass concrete `katoDir`, `runtimeDir`, `statusPath`, stores, or logger
  doubles into the existing APIs
- reserve env mutation only for tests whose purpose is specifically env/default
  resolution

#### Bucket 3: missing top-level seam tests

This bucket is complete. The remaining web auth/logging/recordings/status/live
tests now use additive top-level seams instead of process-env mutation.

#### Bucket 4: true env-boundary serial slice

These tests are supposed to assert env-driven behavior and do not need to be
forced into the parallel-safe slice.

Examples:

- `tests/daemon-control-plane_test.ts`
- `tests/runtime-config_test.ts`
- `tests/path-policy_test.ts`
- `tests/runtime-env_test.ts`
- `tests/daemon-cli_test.ts` env/global-root cases
- `tests/daemon-launcher_test.ts`
- `tests/daemon-main_test.ts`
- `tests/executable-resolution_test.ts`
- `tests/participant-username-resolver_test.ts`

Preferred direction:

- keep them explicit and small
- run them in a dedicated serial slice
- make their ownership obvious in task wiring and docs

#### Bucket 5: lock helper retirement

This bucket is functionally complete:

- `tests/test_env.ts` is now a narrow env-isolation helper
- `withLockedEnvironment(...)` has been replaced by
  `withIsolatedEnvironment(...)`
- the stale-lock heartbeat logic and `.env-lock` directory coordination are no
  longer part of the test contract

## Open Issues

- Should the remaining `withIsolatedEnvironment(...)` uses stay shared through
  `tests/test_env.ts`, or be inlined file-by-file if the serial slice shrinks
  further?
- Which of the remaining env-boundary tests are truly permanent contract tests
  versus candidates for future additive seams?

## Decisions

- Optimize for supporting `deno test --parallel` on the broad parallel-safe
  slice, not for making every last env-sensitive test parallel-safe.
- Prefer a composed root flow (`test:parallel-safe` + serial env slice) over a
  single all-or-nothing root `--parallel` command.
- Retire the shared filesystem env lock now that the root flow has explicit
  ownership for env-boundary suites.
- Prefer dependency/path injection over stronger global locking.
- Prefer test rewrites that use already-existing explicit path/store/logger
  options before adding new production seams.
- Add new seams only at top-level entry points that still hard-wire default
  env-based resolution.
- Keep user-facing runtime and web-init env contracts unchanged; this refactor
  is about testability and internal seams, not changing CLI behavior.
- Keep a small explicit env-boundary slice so default resolution behavior stays
  covered even after most tests move to injected paths.
- Keep `tests/test_env.ts` as a narrow env snapshot/restore helper for the
  serial slice instead of a suite-wide lock.

## Contract Changes

Landed additive internal contract changes:

- Keep targeted explicit test layout fixtures (`katoDir`, `runtimeDir`,
  `statusPath`, `controlPath`, and related paths) instead of introducing a new
  shared runtime-layout helper.
- Add or standardize additive path/dependency override options at top-level
  production helpers that previously required process env during tests,
  including:
  - `loadWebConfig(...)` / `loadWebConfigState(...)`
  - `createWebLoggers(...)`
  - `handleRecordingsPagePost(...)`
  - `startWebServerStatusHeartbeat(...)`
- Standardize password-source injection for web-init tests so they can verify
  env/stdin/prompt precedence without mutating the real process environment.
- Keep existing local `katoDir` / `runtimeDir` / `statusPath` options where
  they already solve the problem; do not force a giant umbrella paths
  abstraction unless repeated churn proves it worthwhile.
- The seam work already landed in this task includes:
  - `loadRuntimeConfigOrDefault(...)` accepting explicit layout input
  - `loadWorkspacesPageData(...)` and summary/activity loaders threading
    explicit `katoDir` / `statusPath`
- Add task-level test split contracts:
  - `test`
  - `test:parallel-safe`
  - `test:env`
- Replace `withLockedEnvironment(...)` with
  `withIsolatedEnvironment(...)`, which restores the bounded allowlisted env
  keys used by the serial env slice.

Non-contract note:

- No user-facing CLI/config schema changes should be required for this refactor.

## Testing

Required coverage for this refactor should include:

- focused regression tests proving migrated slices no longer require shared
  process-env mutation
- focused tests for any new path/dependency override options added to runtime,
  CLI, or web helpers
- explicit boundary tests for:
  - `resolveDefaultRuntimeDir()`
  - `resolveDefaultKatoDir()`
  - `resolveDefaultStatusPath()` / `resolveDefaultControlPath()` env behavior
  - `resolveDefaultAllowedWriteRoots()` env behavior
  - env-driven runtime-config defaults that are intentionally contractful
  - `resolveWebInitPassword()` env fallback behavior
- proof that the parallel-safe slice passes under explicit `deno test --parallel`
- regression coverage that the general suite no longer blocks on env-lock
  contention
- verification that migrated tests still exercise real filesystem behavior under
  `.test-tmp`
- local timing/behavior verification on Windows after each migration phase,
  because that is where the current contention has been easiest to reproduce

Validation workflow during the refactor:

- `deno fmt`
- `deno task check`
- focused `deno test` runs for each migrated slice
- explicit parallel-safe checks, e.g. `deno test --parallel <parallel-safe files>`
  or `deno task test:parallel-safe`
- `deno task test`
- `deno task test:env`

Validated during this task on 2026-03-18:

- `deno task test:parallel-safe --filter 'loadSummaryPageData reads the default shared status snapshot'`
- `deno task test:env --filter 'resolveWebInitPassword reads KATO_WEB_PASSWORD from process env when no override is injected'`
- `deno task test --frozen --filter 'resolveWebInitPassword reads KATO_WEB_PASSWORD from process env when no override is injected'`
- `deno task test:coverage --filter 'loadSummaryPageData reads the default shared status snapshot'`
- `deno task test:env --frozen` (`179` passed)

Timed split refresh on 2026-03-23 (`--frozen --quiet`):

| Environment | `test:parallel-safe` | `test:env` | `test` | `test:coverage` |
| --- | --- | --- | --- | --- |
| Windows | `5.08s` | `21.39s` | `22.42s` | `42.53s` |
| WSL | `4.86s` | `8.24s` | `8.94s` | `14.18s` |

- Windows result counts for those measured runs were `557` passed, `1` ignored
  for `test:parallel-safe`; `179` passed for `test:env`; and `736` passed,
  `1` ignored for both `test` and `test:coverage`.
- Windows `test:coverage` emitted `79.6%` branch / `53.3%` function / `39.0%`
  line in Deno's detailed table, subject to the extracted-source caveat noted
  in [[dev.testing]].
- WSL raw stdout/stderr logs for this refresh are under
  `.test-tmp/timings/wsl/`.
- WSL beat Windows on every measured command: `test:parallel-safe` was
  `0.22s` faster, `test:env` was `13.15s` faster, `test` was `13.48s` faster,
  and `test:coverage` was `28.35s` faster (`36.22s` total versus `91.42s`
  overall).
- `test:env` remains the slower of the two root slices and therefore still
  dominates `test`; `test:coverage` remains the slowest overall command because
  of coverage instrumentation.

Before closing the task:

- confirm the hanging web-init failure path no longer stalls behind unrelated
  tests
- confirm `withLockedEnvironment(...)` usage stays eliminated
- confirm the parallel-safe slice does not rely on `tests/test_env.ts`
- confirm root task / CI wiring and docs match the actual parallelism model
- keep the paired Windows + WSL timing baseline current if the split flow
  changes materially

## Non-Goals

- Do not change the user-facing meaning of `KATO_RUNTIME_DIR`,
  `HOME`/`USERPROFILE`, or `KATO_WEB_PASSWORD`.
- Do not convert all filesystem-backed tests to in-memory stores if the real
  filesystem behavior is part of the contract being tested.
- Do not treat the Deno Windows client-pipe panic as part of this task; that is
  a separate tooling/runtime issue.
- Do not treat the current root `test` task wiring as proof that `--parallel`
  support is already solved.
- Do not restore or advertise broad `--parallel` support as an optimistic first
  step before the parallel-safe slice is actually measured.
- Do not hide remaining env coupling under a more complex global lock and call
  the problem solved.
- Do not require every env contract test to become parallel-safe if that
  reduces clarity or weakens the contract coverage.

## Implementation Plan

- [x] Refresh and record the `withLockedEnvironment(...)` inventory and split it
      into migration buckets in this task note.
- [x] Remove accidental lock usage from `tests/cli-command-direct_test.ts`.
- [x] Collapse most `tests/web-cli_test.ts` coverage to injected
      password-source tests and keep only a tiny serial env-fallback slice.
- [x] Reassess whether a reusable test runtime-layout helper is still needed.
      Targeted explicit temp-root fixtures were sufficient for this migration
      wave, so no shared helper was added.
- [x] Rewrite default-path tests that already have usable override seams to pass
      explicit temp roots instead of rewriting `HOME` / `USERPROFILE`:
      - `tests/user-settings_test.ts`
      - `tests/workspace-mutations_test.ts`
      - `tests/web-session-ingestion_test.ts`
      - `tests/web-session-actions_test.ts`
      - `tests/web-summary-loader_test.ts`
      - `tests/web-log-loader_test.ts`
      - `tests/web-activity-loader_test.ts`
- [x] Add additive loader seams where lower-level path overrides already
      existed but summary/activity entry points still hard-wired defaults:
      - `apps/web/src/loaders/workspaces.ts`
      - `apps/web/src/loaders/activity_state.ts`
      - `apps/web/src/loaders/status.ts`
      - `apps/web/src/loaders/sessions.ts`
- [x] Add remaining additive top-level seams where route/entry-point helpers
      still hard-wire defaults:
      - `apps/web/src/auth.ts`
      - `apps/web/src/logging.ts`
      - `apps/web/src/recordings_page_post.ts`
      - `apps/web/src/server_status.ts`
- [x] Migrate route / loader / auth / status tests that currently depend on
      those top-level defaults:
      - `tests/web-auth_test.ts`
      - `tests/web-recordings-page-post_test.ts`
      - `tests/web-server-status_test.ts`
      - `tests/web-live-routes_test.ts`
      - `tests/web-logging_test.ts`
- [x] Carve the true env-boundary tests into a dedicated serial slice and
      document its ownership:
      - `tests/daemon-control-plane_test.ts`
      - `tests/runtime-config_test.ts`
      - `tests/path-policy_test.ts`
      - `tests/runtime-env_test.ts`
      - env-focused cases in `tests/daemon-cli_test.ts`
      - `tests/daemon-launcher_test.ts`
      - `tests/daemon-main_test.ts`
      - `tests/executable-resolution_test.ts`
      - `tests/participant-username-resolver_test.ts`
- [x] Reduce `tests/test_env.ts` from suite-wide coordination helper to a
      narrow `withIsolatedEnvironment(...)` env restore helper used only by
      boundary tests.
- [x] Add task wiring for a broad `test:parallel-safe` slice plus a small serial
      `test:env` slice, and make root `test` / `test:coverage` reflect that
      model.
- [x] Pair the recorded 2026-03-23 Windows timing refresh with matching WSL
      measurements for the new `test:parallel-safe` / `test:env` split and
      refresh the measured baseline.
- [x] Update `[[dev.testing]]`, `[[dev.general-guidance]]`, and
      `[[dev.decision-log]]` to reflect the final test-isolation model and
      parallelism policy.
