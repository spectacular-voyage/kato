---
id: kclfduln80f7td4hcfuszi4
title: Testing
desc: ""
updated: 1772573000000
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

## Test Levels

1. Fast local verification:
   - `deno task check`
   - `deno task test`
2. Full gate:
   - `deno task ci`

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
