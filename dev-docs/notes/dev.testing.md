---
id: kclfduln80f7td4hcfuszi4
title: Testing
desc: ""
updated: 1771811926065
created: 1771811926065
---

## Purpose

This note tracks practical testing workflows for Kato, including a repeatable
MVP smoke test.

All `deno run -A ...` commands below are source/dev invocations. For production
packaging, prefer a compiled binary with explicitly scoped permissions.

## Test Levels

1. Fast local verification:
   - `deno task check`
   - `deno task test`
2. Full gate:
   - `deno task ci`

## MVP Smoke Test Runbook

This runbook validates currently implemented MVP slices:

- CLI command surface (`init`, `start`, `stop`, `status`, `export`, `clean`)
- runtime config bootstrap and fail-closed loading
- detached daemon start/stop and status files
- control queue request enqueue behavior
- provider ingestion from configured session roots
- provider-backed export output (`kato export <session-id>`)

### Preconditions

1. Run from repo root (`kato/`).
2. Deno 2.x installed.
3. No critical local data in `.kato/` you need to keep.

### 0) Optional clean baseline

```bash
rm -rf .kato
```

Expected:

- `.kato/` removed if present.

### 1) Initialize runtime config

```bash
deno run -A apps/daemon/src/main.ts init
```

Expected:

- Output contains either:
  - `created runtime config at ...`, or
  - `runtime config already exists at ...`
- `.kato/config.json` exists.

### 2) Configure provider roots and seed fixture

```bash
deno eval -A 'const path=".kato/config.json"; const cfg=JSON.parse(await Deno.readTextFile(path)); cfg.providerSessionRoots={claude:[".kato/test-provider/claude"],codex:[".kato/test-provider/codex"]}; await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));'
mkdir -p .kato/test-provider/codex
cp tests/fixtures/codex-session-vscode-new.jsonl .kato/test-provider/codex/smoke-codex.jsonl
```

Expected:

- `.kato/config.json` includes `providerSessionRoots`.
- `.kato/test-provider/codex/smoke-codex.jsonl` exists.

### 3) Start daemon

```bash
deno run -A apps/daemon/src/main.ts start
```

Expected:

- Output contains:
  - `kato daemon started in background (pid: ...)`
- `.kato/runtime/status.json` exists and eventually reports
  `daemonRunning: true`.

### 4) Check status

```bash
deno run -A apps/daemon/src/main.ts status
deno run -A apps/daemon/src/main.ts status --json
```

Expected:

- Text status renders without error.
- JSON includes:
  - `schemaVersion`
  - `daemonRunning`
  - `heartbeatAt`
  - `recordings`

### 5) Verify provider ingestion + real export

```bash
deno run -A apps/daemon/src/main.ts status --json
deno run -A apps/daemon/src/main.ts export sess-vscode-001 --output .kato/runtime/smoke-export.md
sleep 2
cat .kato/runtime/smoke-export.md
```

Expected:

- `status --json` eventually reports a non-empty `providers` list with
  `provider: "codex"` and `activeSessions >= 1`.
- Export command reports `export request queued ...`.
- Export file exists and contains parsed conversation content (assistant/user
  messages).

### 6) Queue clean request

```bash
deno run -A apps/daemon/src/main.ts clean --all --dry-run
```

Expected:

- Command reports `... request queued ...`.
- `.kato/runtime/control.json` includes queued requests.

### 7) Stop daemon

```bash
deno run -A apps/daemon/src/main.ts stop
```

Expected:

- Output indicates stop queued or stale status reset path.
- `status` eventually reports daemon not running.

### 8) Fail-closed config check (unknown feature flag)

1. Edit `.kato/config.json` and add an unknown key under `featureFlags`, e.g.:
   - `"futureFlagThatDoesNotExist": true`
2. Run:

```bash
deno run -A apps/daemon/src/main.ts start
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
   - Run `deno run -A apps/daemon/src/main.ts init`.
2. `Runtime config file has unsupported schema`:
   - Inspect `.kato/config.json` for invalid shape/unknown `featureFlags` keys.
3. `Export path denied by policy`:
   - Use an output path within configured `allowedWriteRoots`.
4. Status appears running right after failed start:
   - Known MVP limitation; wait for stale-heartbeat window or run `stop`.
