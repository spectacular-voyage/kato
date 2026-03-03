---
id: d1xpvv6eb3b6v08a24nql2a
title: 2026 03 03 CLI Daemon Separation
desc: ""
updated: 1772562200662
created: 1772562200662
---

## Goal

Clarify ownership boundaries between daemon process config, shared behavior
config, and client UX config so versioning/status/config scale cleanly to CLI,
web app, and service.

## Summary

Recommendation:

1. Split global config into daemon-owned and shared-behavior files.
2. Keep a client config scope optional (only when we have true client-only
   settings).
3. Version CLI and daemon independently.
4. Update status top line to display both versions.

Target top status line:

`kato CLI (v0.2.0)  ·  kato daemon (v0.1.2): running (pid: 97046)  ·  refreshed 08:00:50`

## Discussion

### 1) Config domain split recommendation

Current `kato-daemon-config.yaml` mixes daemon process/runtime settings with
shared behavior defaults. That blocks independent evolution across CLI, web, and
service.

Recommended split:

- `~/.kato/kato-daemon-config.yaml` (daemon-owned)
  - runtime/state paths: `runtimeDir`, `katoDir`, `statusPath`, `controlPath`
  - ingestion/discovery: `providerSessionRoots`
  - daemon behavior: `globalAutoGenerateSnapshots`,
    `providerAutoGenerateSnapshots`, `cleanSessionStatesOnShutdown`,
    `daemonFeatureFlags`, `daemonMaxMemoryMb`
  - daemon logging controls (`operationalLevel`, `auditLevel`)
- `~/.kato/kato-shared-config.yaml` (shared behavior/policy)
  - `allowedWriteRoots` (policy contract, daemon-enforced)
  - export defaults: `exportTimezone`, `exportMarkdownFrontmatter`,
    `exportFeatureFlags`
  - future cross-client behavior defaults (applies to CLI/web/service requests)
- Optional client config (create only when needed)
  - examples: CLI live refresh interval, text truncation/session cap, view
    defaults
  - proposed path when needed: `~/.kato/kato-cli-config.yaml`

Keep as-is:

- `~/.kato/kato-user-config.yaml` for user identity/participant mapping
- workspace configs for workspace-scoped output behavior

Key design rule:

- Client resolves effective behavior defaults (workspace > shared > built-in)
  and sends explicit request payload; daemon executes payload as-is.
- Daemon process config should never carry client presentation concerns.

### 2) Logging split recommendation

Logging should be split by process ownership, not by transport client:

- Daemon logging config stays daemon-scoped (`kato-daemon-config.yaml`).
- Each future client process (CLI/web/service) gets its own logging config under
  its process config surface.
- Shared config should contain behavior/policy, not sink-level logging
  implementation details.

This keeps daemon observability stable while allowing web/service to evolve log
pipelines independently.

### 3) CLI/daemon versioning recommendation

Current model exposes one shared version. That is misleading because:

- CLI binary/build can change without daemon restart.
- Running daemon may be older/newer than invoking CLI.

Recommended model:

- Add `CLI_APP_VERSION` sourced from a CLI-specific manifest
  (`apps/cli/deno.json` or equivalent).
- Keep `DAEMON_APP_VERSION` sourced from daemon manifest
  (`apps/daemon/deno.json`).
- `kato --version` returns CLI version.
- Daemon writes its own version into status snapshot each heartbeat.

### 4) Status line recommendation

Current status header should be replaced with explicit dual-version identity:

- `kato CLI (v<cli>)  ·  kato daemon (v<daemon>): <state>  ·  refreshed <HH:mm:ss>`

Daemon version source in `kato status`:

- Read from status snapshot field written by daemon process.
- If unavailable, render `unknown`.

### 5) Entrypoint split recommendation (`apps/cli` vs `apps/daemon`)

Current command entrypoint is `apps/daemon/src/main.ts`, which multiplexes:

- CLI command handling
- daemon subprocess mode (`__daemon-run`)

Recommendation:

- Move user-invoked command entrypoint to `apps/cli/src/main.ts`.
- Keep daemon process entrypoint in `apps/daemon/src/main.ts` (or
  `apps/daemon/src/subprocess_main.ts`) as daemon-only runtime bootstrap.
- Update launcher to spawn daemon-only entrypoint path explicitly.

Rationale:

- avoids daemon entrypoint importing CLI graph
- enables independent CLI packaging/versioning
- aligns with web/service clients that should call a shared control API, not
  daemon internals

Process model impact:

- Current fork model (CLI spawns detached daemon) remains valid.
- No fundamental blocker as long as launcher path resolution and permissions
  stay explicit.
- Main risk is path-coupling regressions; cover with launcher tests.

### 6) Filesystem layout recommendation

The proposed direction is right, with two important tweaks:

1. Use `~/.kato/shared/...` (not `~/kato/shared/...`).
2. Keep logs process-local (`daemon/` and `cli/`) instead of one shared log file
   written by multiple processes.

Recommended default layout:

```text
~/.kato/
  kato-user-config.yaml

  shared/
    kato-shared-config.yaml
    status.json
    workspace-registry.json
    default-kato-workspace-config.yaml
    sessions/
      *.meta.json
      *.twin.jsonl
    ipc/
      daemon-control.json

  daemon/
    kato-daemon-config.yaml
    logs/
      operational.jsonl
      security-audit.jsonl

  cli/
    kato-cli-config.yaml
    logs/
      operational.jsonl
      security-audit.jsonl
```

Rationale:

- `shared/` holds cross-process state/contracts (status, queue, sessions,
  registry, shared defaults).
- `daemon/` and `cli/` hold process-owned config + logs.
- Avoids concurrent append contention and mixed provenance in one shared log
  stream.

## Contract Changes

- Add `SharedBehaviorConfig` contract in `shared/src/contracts/config.ts`.
- Add `SharedBehaviorConfigFileStore`.
- Remove shared behavior fields from `RuntimeConfig`:
  - `allowedWriteRoots`
  - `exportTimezone`
  - `exportMarkdownFrontmatter`
  - `exportFeatureFlags`
- Keep `RuntimeConfig` daemon-process-only.
- Extend export/write request payloads to carry explicit resolved behavior
  defaults.
- Extend `DaemonStatusSnapshot` with daemon version field (recommended required
  for new schema).
- Optional later: add `CliViewConfig` contract only once first client-only knob
  is introduced.
- Add explicit CLI process entrypoint contract (`apps/cli/src/main.ts`) and
  daemon process entrypoint contract (`apps/daemon/...`).

## Testing

- Parser/store tests for new CLI config schema.
- `kato init` tests ensure daemon/user/shared config files are scaffolded.
- Export command tests verify CLI defaults are transmitted in request payload.
- Runtime tests verify daemon executes payload-provided export overrides.
- Status rendering tests verify dual-version top line format.
- Daemon status store tests verify snapshot version field round-trips.

## Non-Goals

- Supporting legacy fallback/auto-migration for old file names or old schema.
- Reworking workspace config shape in this task.
- Reworking in-chat command syntax in this task.

## Implementation Plan

### A) Config ownership split

- [ ] Add `SharedBehaviorConfig` schema + defaults + file store.
- [ ] Wire CLI/bootstrap to load daemon + shared config stores.
- [ ] Remove behavior/policy fields from daemon runtime config/store.
- [ ] Update `kato init` scaffolding to create `kato-shared-config.yaml`.
- [ ] Keep CLI config out of scope unless we add first real client-only key.

### B) Export request payload ownership

- [ ] Extend export request payload to include render defaults.
- [ ] Populate payload from workspace/shared defaults in `kato export` path.
- [ ] Consume payload in daemon runtime export execution.

### C) Version separation

- [ ] Add dedicated CLI version source and constant (`CLI_APP_VERSION`).
- [ ] Keep daemon version source as `DAEMON_APP_VERSION`.
- [ ] Ensure status snapshots include daemon version.

### D) Status line format

- [ ] Update status header rendering to dual-version format.
- [ ] Update status tests/goldens for exact top-line output.

### E) Docs

- [ ] Update README config section with daemon + shared + user model (plus
      optional client config policy).
- [ ] Update `dev.codebase-overview` and `dev.testing`.

### F) Process Entrypoints

- [ ] Add `apps/cli/src/main.ts` as user-facing command entrypoint.
- [ ] Make daemon entrypoint daemon-only (no CLI branching).
- [ ] Update detached launcher target path + tests.
- [ ] Update runbook/docs to invoke CLI via `apps/cli/src/main.ts`.
