---
id: kclfduln80f7td4hcfuszi4
title: Testing
desc: ""
updated: 1772813627045
created: 1771811926065
---

## Purpose

This note tracks practical testing workflows for Kato, including a repeatable
MVP smoke test under the current CLI/daemon split.

All `deno run -A ...` commands below are source/dev invocations. For production
packaging, prefer a compiled binary with explicitly scoped permissions.

## Filesystem Space for Tests

`.test-tmp/` is the designated scratch directory for tests that need to touch
the real filesystem (e.g. creating config files, writing outputs). It is listed
in `.gitignore` so artifacts left behind do not pollute the repo or diff.

Use it any time a test must write to an actual path instead of an in-memory
store. Prefer `makeTestTempDir("my-test-prefix-")` from `tests/test_temp.ts` to
get a unique subdirectory under `.test-tmp/` that can be removed in a `finally`
block. If you hard-code a path (e.g. for tests that do not need isolation), use
`.test-tmp/` as the parent so it stays out of `.kato/`.

Raw Deno coverage profiles should also stay under `.test-tmp/coverage/` rather
than top-level `.coverage*` directories. The root `test:coverage` task now uses
`.test-tmp/coverage/root`, and focused local coverage runs should use a labeled
subdirectory such as `.test-tmp/coverage/status` or
`.test-tmp/coverage/provider-ingestion`.

Focused tests that use `tests/test_temp.ts` or otherwise create real files
under `.test-tmp/` should be run with filesystem permission, typically
`deno test -A <file>` during local development. A plain `deno test <file>`
will fail with `NotCapable` for those suites.

## Test Levels

1. Fast local verification:
   - `deno task check`
   - `deno task test`
2. Full gate:
   - `deno task ci`

The root `test` and `test:coverage` tasks now use Deno module parallelism by
default. Local verification on 2026-03-06 stayed deterministic with both
`deno task test --frozen --quiet` and
`deno task test:coverage --frozen --quiet`, including after adding direct JSONL
writer, session-twin mapper, runtime-config, shared-behavior config,
path-policy, launcher, status-command, control-plane, env-helper,
status-error-cursor, CLI parser, direct start / workspace-init / export command
tests, direct hash tests, and Codex parser tests, status-workspace tests,
provider-session-discovery tests, daemon-status-projection tests,
daemon-export-request tests, and daemon-first-seen tests, daemon-command-state
tests, daemon-memory-telemetry tests, daemon-workspace-paths tests,
daemon-workspace-output-state tests, provider-ingestion-resume tests,
provider-ingestion-merge tests, daemon-command-destination tests, plus a shared
env lock in `tests/test_env.ts` for env-mutating cases.

GitHub CI uses a split gate:

- `deno task ci:quality` for `fmt` + `lint` + `check`
- `deno task test:coverage --frozen` for the test suite and coverage artifact

This keeps local `deno task ci` as the full pre-PR gate while avoiding running
the full test suite twice in GitHub Actions.

## Test File Selection

The root `deno task test` and `deno task test:coverage` commands intentionally
run:

- `main_test.ts`
- `tests/**/*_test.ts`

Helper modules under `tests/` such as `tests/test_env.ts` and
`tests/test_temp.ts` are shared test utilities, not standalone test modules.
Import them from test files, but do not point scripted runs at `tests/**/*.ts`
or they will be loaded as zero-test modules.

## Focused Regression Slices

When working on twin-cleanup behavior, the most useful focused slice is:

- `deno test -A tests/maintenance-clean_test.ts`
- `deno test -A tests/daemon-cli_test.ts`
- `deno test -A tests/cli-parser_test.ts`
- `deno task --cwd apps/web check`

That slice now covers:

- runtime dry-run and execute behavior for `clean --twins`
- default twin cleanup preserving metadata while clearing twin-only state
- opt-in metadata deletion via `--delete-metadata` / Maintenance checkbox
- CLI parser enforcement that metadata deletion is only accepted with
  `--twins`

When working on on-demand snippet recovery, the most useful focused slice is:

- `deno test -A tests/web-session-snippets_test.ts`
- `deno test -A tests/web-live-routes_test.ts --filter "session snippet"`
- `deno task --cwd apps/web check`

That slice now covers:

- `resolveSessionSnippet()` preferring live snippets over replayed persisted
  history
- twin-history recovery when source replay is intentionally disabled
- twin-history precedence over source replay when both paths are allowed
- unavailable outcomes for missing metadata, no twin history, and empty source
  replay

If you want per-file coverage confirmation for that helper, run:

- `deno test -A --coverage=.test-tmp/coverage/web-session-snippets tests/web-session-snippets_test.ts tests/web-live-routes_test.ts`
- `deno coverage --detailed .test-tmp/coverage/web-session-snippets`

That focused coverage run currently drives
`apps/web/src/session_snippets.ts` to `100%` branch and `100%` line coverage.

When working on session inventory/manual-ingestion route behavior, the most
useful focused slice is:

- `deno test -A tests/web-session-routes_test.ts`
- `deno test -A tests/web-live-routes_test.ts`
- `deno test -A tests/web-session-ingestion_test.ts`
- `deno test -A tests/daemon-runtime_test.ts --filter "title"`
- `deno task --cwd apps/web check`

That slice now covers:

- session and maintenance href builders normalizing `view=active` and trimmed
  workspace filters
- the session-snippet live route failing closed when `sessionId` is missing
- manual ingestion preserving `ingestionActivatedAt` on no-op twin updates
- manual ingestion rejecting opaque resume cursors instead of guessing
- daemon capture title fallback from stored snapshot snippet to extracted
  conversation snippet

## Coverage Workflow

1. Generate a fresh raw coverage profile:
   - `deno task test:coverage --frozen`
2. Inspect local hotspots:
   - `deno coverage --detailed .test-tmp/coverage/root`
3. Generate the LCOV artifact used by GitHub CI / Codecov:
   - `deno task coverage:lcov`

For focused local work, prefer specific `_test.ts` files and `--filter` instead
of rerunning the whole suite. If you need a manual raw profile, write it under
`.test-tmp/coverage/<label>` instead of creating a new top-level `.coverage-*`
directory.

Current local timings from 2026-03-11:

- `deno task test --frozen --quiet`: `607` passing tests, `12.88s` real
- `deno task test:coverage --frozen --quiet`: `607` passing tests, `80.0%` line
  coverage, `84.9%` branch coverage, `14.17s` real

Treat those numbers as a dated baseline, not a contract. Refresh this block
after material test-count or runtime changes land.

Current coverage-report caveat:

- `deno coverage --detailed .test-tmp/coverage/root` currently warns that some
  extracted modules may be missing transpiled source, including
  `apps/runtime/src/orchestrator/launcher.ts`,
  `apps/cli/src/commands/status.ts`,
  `apps/cli/src/commands/status_workspace.ts`,
  `apps/daemon/src/orchestrator/provider_ingestion.ts`, and
  `apps/daemon/src/orchestrator/provider_session_discovery.ts`, and
  `apps/daemon/src/orchestrator/runtime_export_request.ts`, and
  `apps/daemon/src/orchestrator/runtime_first_seen.ts`, and
  `apps/daemon/src/orchestrator/runtime_status_projection.ts`. Treat the summary
  emitted by `deno task test:coverage --frozen --quiet` as the authoritative
  repo-wide baseline when that reporting quirk appears, and use focused coverage
  runs for per-file work.

## Security Automation

CI now has an initial advisory-only security automation slice:

- `CodeQL` scans the TypeScript codebase with a local-threat-model emphasis.
- `OSV-Scanner` runs with `fail-on-vuln: false`, so findings should surface
  without failing the workflow solely because vulnerabilities were detected.

Important caveat:

- `OSV-Scanner` does not currently list `deno.lock` as a native supported
  lockfile format, so immediate dependency-vulnerability signal for this
  Deno-first repo may be limited until we add a supported SBOM or another
  compatible dependency input.

## Windows-Compatible Tests

Use these patterns to keep tests portable across Windows/macOS/Linux:

1. Build expected paths with `join(...)` instead of hardcoded `/` strings.
2. Do not assert on raw JSON text when it includes file paths.
   - Parse JSON and assert object fields
     (`assertEquals(parsed.path, expected)`).
3. For command outputs or logs that may normalize separators differently,
   compare normalized values (for example, convert `\\` to `/` before
   asserting).
4. Avoid test fixtures that require Windows-invalid filenames.
   - Example: `:` is not valid in Windows filenames.
5. Gate platform-specific behavior explicitly when needed.
   - Use `Deno.test({ ..., ignore: Deno.build.os === "windows" })` only when
     there is no meaningful cross-platform equivalent for that specific case.
6. Prefer asserting semantic behavior over string shape.
   - Example: verify resolved destination points to the expected location, not
     that the rendered path uses a specific separator style.

## MVP Smoke Test Runbook

This runbook validates currently implemented MVP slices:

- CLI command surface (`init`, `start`, `stop`, `status`, `export`, `clean`)
- daemon/shared config bootstrap and fail-closed loading
- detached daemon start/stop and shared control/status files
- control queue request enqueue behavior
- provider ingestion from configured session roots
- provider-backed export output (`kato export <session-id>`)

### Preconditions

1. Run from repo root (`kato/`).
2. Deno 2.x installed.
3. No critical local data in `~/.kato/` you need to keep.

### 0) Optional clean baseline

```bash
rm -rf ~/.kato
```

Expected:

- `~/.kato/` removed if present.

### 1) Initialize config

```bash
deno run -A apps/cli/src/main.ts init
```

Expected:

- Output contains created/already-exists lines for:
  - runtime config (`~/.kato/daemon/kato-daemon-config.yaml`)
  - shared config (`~/.kato/shared/kato-shared-config.yaml`)
  - CLI config (`~/.kato/cli/kato-cli-config.yaml`)
  - default workspace config
    (`~/.kato/shared/default-kato-workspace-config.yaml`)
  - user config (`~/.kato/kato-user-config.yaml`)

### 2) Configure provider roots, write roots, and seed fixture

```bash
deno run -A scripts/smoke-test-setup.ts
mkdir -p ~/.kato/test-provider/claude ~/.kato/test-provider/codex ~/.kato/test-provider/gemini ~/.kato/test-output
cp tests/fixtures/codex-session-vscode-new.jsonl ~/.kato/test-provider/codex/smoke-codex.jsonl
```

Expected:

- `~/.kato/daemon/kato-daemon-config.yaml` includes `providerSessionRoots`.
- `~/.kato/shared/kato-shared-config.yaml` includes `allowedWriteRoots`.
- `~/.kato/test-provider/codex/smoke-codex.jsonl` exists.

### 3) Start daemon

```bash
deno run -A apps/cli/src/main.ts start
```

Expected:

- Output contains `kato daemon started in background (pid: ...)`.
- `~/.kato/shared/status.json` exists and eventually reports
  `daemonRunning: true`.

### 4) Check status

```bash
deno run -A apps/cli/src/main.ts status
deno run -A apps/cli/src/main.ts status --json
```

Expected:

- Text status renders without error.
- JSON includes:
  - `schemaVersion`
  - `daemonRunning`
  - `heartbeatAt`
  - `recordings`

### 5) Verify provider ingestion + markdown export

```bash
deno run -A apps/cli/src/main.ts status --json
deno run -A apps/cli/src/main.ts export sess-vscode-001 --output ~/.kato/test-output/smoke-export.md
sleep 2
cat ~/.kato/test-output/smoke-export.md
```

Expected:

- `status --json` eventually reports a non-empty `providers` list with
  `provider: "codex"` and `activeSessions >= 1`.
- Export command reports `export request queued ...`.
- Export file exists and contains parsed conversation content (assistant/user
  messages, tool calls rendered as collapsible sections).

### 5b) Verify JSONL export format

```bash
deno run -A apps/cli/src/main.ts export sess-vscode-001 --output ~/.kato/test-output/smoke-export.jsonl --format jsonl
sleep 2
head -1 ~/.kato/test-output/smoke-export.jsonl | deno eval -A 'const line=await new Response(Deno.stdin).text(); const e=JSON.parse(line); console.log(e.kind, e.eventId);'
```

Expected:

- JSONL file exists with one `ConversationEvent` JSON object per line.
- Each line includes `kind`, `eventId`, `provider`, `sessionId`, `timestamp`.

### 6) Run clean (CLI-owned)

```bash
deno run -A apps/cli/src/main.ts clean --all --dry-run
```

Expected:

- Command reports `clean completed mode=dry-run ...`.
- Report includes `logsToFlush=<n>` and `missingFiles=<n>`.
- No control-plane request is enqueued; `clean` executes immediately in CLI.

### 7) Stop daemon

```bash
deno run -A apps/cli/src/main.ts stop
```

Expected:

- Output indicates stop queued or stale status reset path.
- `status` eventually reports daemon not running.

### 8) Fail-closed config check (unknown daemon feature flag)

1. Edit `~/.kato/daemon/kato-daemon-config.yaml` and add an unknown key under
   `daemonFeatureFlags`, for example:
   - `futureFlagThatDoesNotExist: true`
2. Run:

```bash
deno run -A apps/cli/src/main.ts start
```

Expected:

- Startup fails with:
  - `Command failed: Runtime config file has unsupported schema`

3. Remove the unknown key and rerun `start`.

### 9) Restore baseline and run full gate

```bash
deno task ci
```

Expected:

- `fmt`, `lint`, `check`, and `test` all pass.

## Troubleshooting

1. `Runtime config not found ... Run kato init first`:
   - Run `deno run -A apps/cli/src/main.ts init`.
2. `Runtime config file has unsupported schema`:
   - Inspect `~/.kato/daemon/kato-daemon-config.yaml` for invalid shape/unknown
     `daemonFeatureFlags` keys.
3. `Export path denied by policy`:
   - Add the target parent directory to `~/.kato/shared/kato-shared-config.yaml`
     -> `allowedWriteRoots`.
4. Status appears running right after failed start:
   - Known MVP limitation; wait for stale-heartbeat window or run `stop`.
