---
id: d1xpvv6eb3b6v08a24nql2a
title: 2026 03 03 CLI Daemon Separation
desc: ''
updated: 1772565890156
created: 1772562200662
---
# Plan: Daemon/Shared/Client Separation with Full CLI Extraction

## Summary
Implement a breaking, decision-complete refactor that separates process concerns and shared contracts:

1. Extract CLI into `apps/cli` with strict independence from `apps/daemon`.
2. Split config into three scopes:
- daemon process config
- shared behavior/policy config
- CLI process config (logging-only in this phase)
3. Move cross-process state/contracts under `~/.kato/shared`.
4. Keep one shared control queue file in `~/.kato/shared/ipc/daemon-control.json` (queue hardening deferred).
5. Split versioning and status identity:
- CLI version from `apps/cli/deno.json`
- daemon version from `apps/daemon/deno.json`
- top status line shows both.

Selected decisions to lock:
- migration mode: hard break now, manual migration only
- entrypoint scope: full CLI extraction
- CLI independence: strict independence now (`apps/cli` does not import from `apps/daemon`)
- export request policy: daemon may fallback to shared config defaults when payload fields are missing
- control path: shared IPC path
- queue hardening: deferred
- logging topology: process-local logs
- CLI config scope now: logging only

## Filesystem and Runtime Contract
Default layout:

- `~/.kato/kato-user-config.yaml`
- `~/.kato/shared/kato-shared-config.yaml`
- `~/.kato/shared/status.json`
- `~/.kato/shared/ipc/daemon-control.json`
- `~/.kato/shared/sessions/*.meta.json`
- `~/.kato/shared/sessions/*.twin.jsonl`
- `~/.kato/shared/workspace-registry.json`
- `~/.kato/shared/default-kato-workspace-config.yaml`
- `~/.kato/daemon/kato-daemon-config.yaml`
- `~/.kato/daemon/logs/operational.jsonl`
- `~/.kato/daemon/logs/security-audit.jsonl`
- `~/.kato/cli/kato-cli-config.yaml`
- `~/.kato/cli/logs/operational.jsonl`
- `~/.kato/cli/logs/security-audit.jsonl`

## Public API / Interface / Type Changes
- [x] Add `SharedBehaviorConfig` to shared contracts.
- [x] Add `CliConfig` to shared contracts (logging-only fields in this phase).
- [x] Reduce `RuntimeConfig` to daemon-process fields only.
- [x] Add daemon version to status snapshot schema and bump status schema version to `2`.
- [x] Extend export control payload contract with optional resolved rendering fields.
- [x] Keep daemon control queue schema as-is for now, only path/location changes.
- [x] Introduce CLI app version constant and daemon app version constant from separate manifests.

## Exact Config Ownership
Daemon config (`kato-daemon-config.yaml`) includes:
- `schemaVersion`
- `runtimeDir` (daemon process runtime root, default `~/.kato/daemon`)
- `providerSessionRoots`
- `globalAutoGenerateSnapshots`
- `providerAutoGenerateSnapshots`
- `cleanSessionStatesOnShutdown`
- `daemonFeatureFlags`
- `logging`
- `daemonMaxMemoryMb`

Shared config (`kato-shared-config.yaml`) includes:
- `schemaVersion`
- `allowedWriteRoots`
- `exportTimezone`
- `exportMarkdownFrontmatter`
- `exportFeatureFlags`

CLI config (`kato-cli-config.yaml`) includes:
- `schemaVersion`
- `logging` (`operationalLevel`, `auditLevel`)

User config remains:
- `participants.defaultUsername`
- `participants.workspaceUsernames`
- `participants.excludeMeFromParticipantList`

## Architecture and Code Organization
- [x] Create `apps/cli` application.
- [x] Move parser/router/usage/commands from daemon CLI package into `apps/cli/src`.
- [x] Make daemon app daemon-only:
- [x] `apps/daemon/src/main.ts` handles subprocess/runtime only.
- [x] Remove CLI branching from daemon main.
- [x] Introduce a neutral shared runtime library package for strict independence.
- [x] Move reusable local-runtime modules needed by both CLI and daemon into a non-daemon namespace.
- [x] Relocate config stores/path resolvers.
- [x] Relocate control/status stores and path resolvers.
- [x] Relocate shared policy path gate.
- [x] Relocate shared observability logger abstractions/sinks used by both processes.
- [x] Relocate workspace registry/template stores used by CLI and daemon.
- [x] Ensure `apps/cli` imports only from neutral/shared modules, never from `apps/daemon`.
- [x] Update launcher to spawn daemon-only entrypoint path.

## Status Line and Versioning
- [x] `kato --version` returns CLI version.
- [x] Daemon writes `daemonVersion` into status snapshots.
- [x] Status top line format becomes exactly:
`kato CLI (v<cli>)  ·  kato daemon (v<daemon>): <state>  ·  refreshed <HH:mm:ss>`
- [x] If daemon version unavailable, render `unknown`.

## Export Payload and Fallback Policy
- [x] CLI computes resolved export defaults from precedence:
- [x] Workspace config override.
- [x] Shared config fallback.
- [x] Built-in defaults.
- [x] CLI includes resolved values in export payload whenever available.
- [x] Daemon behavior on missing payload fields:
- [x] Fallback to daemon-loaded shared config values.
- [x] If shared config is invalid or unavailable, fail closed with explicit command error.
- [x] Document that behavior defaults are daemon-applied contracts, not CLI-only presentation.

## Migration Plan (Hard Break, Manual)
Provide documented one-time migration commands:

- [x] Create directories:
- [x] `~/.kato/shared`
- [x] `~/.kato/shared/ipc`
- [x] `~/.kato/shared/sessions`
- [x] `~/.kato/daemon`
- [x] `~/.kato/cli`
- [x] Move files:
- [x] `~/.kato/kato-daemon-config.yaml` -> `~/.kato/daemon/kato-daemon-config.yaml`
- [x] `~/.kato/workspace-registry.json` -> `~/.kato/shared/workspace-registry.json`
- [x] `~/.kato/default-kato-workspace-config.yaml` -> `~/.kato/shared/default-kato-workspace-config.yaml`
- [x] Existing session state directory -> `~/.kato/shared/sessions/`.
- [x] Current status/control files -> shared paths.
- [x] Regenerate missing new files:
- [x] `kato init` scaffolds shared and CLI config files if absent.
- [x] Restart daemon after migration.

Suggested one-time migration command sequence (also documented in `README.md`):

```bash
mkdir -p ~/.kato/shared/ipc ~/.kato/shared/sessions ~/.kato/daemon ~/.kato/cli
mv ~/.kato/kato-daemon-config.yaml ~/.kato/daemon/kato-daemon-config.yaml
mv ~/.kato/workspace-registry.json ~/.kato/shared/workspace-registry.json
mv ~/.kato/default-kato-workspace-config.yaml ~/.kato/shared/default-kato-workspace-config.yaml
mv ~/.kato/sessions/* ~/.kato/shared/sessions/
mv ~/.kato/daemon-control.json ~/.kato/shared/daemon-control.json
mv ~/.kato/runtime/status.json ~/.kato/shared/status.json
mv ~/.kato/runtime/control.json ~/.kato/shared/ipc/daemon-control.json
deno run -A apps/cli/src/main.ts init
deno run -A apps/cli/src/main.ts restart
```

No legacy fallback, no auto-move logic, no dual-read window.

## Implementation Steps
- [x] Foundation and module boundaries.
- [x] Add `apps/cli` app manifest and entrypoint.
- [x] Extract CLI code into `apps/cli` and update imports to neutral/shared modules.
- [x] Refactor daemon main to daemon-only runtime bootstrap.
- [x] Introduce new config contracts/stores and remove mixed fields from daemon runtime config.
- [x] Introduce shared path resolvers and update all default paths to new layout.
- [x] Move status/control/sessions/workspace template/registry path usage to shared paths.
- [x] Add CLI logging config and default CLI log sinks to `~/.kato/cli/logs`.
- [x] Add daemon version to status snapshot and update status rendering.
- [x] Update launcher for daemon-only entrypoint.
- [x] Update init scaffolding for daemon/shared/cli/user files.
- [x] Update docs/runbooks/README/task notes.

## Test Cases and Scenarios
- [x] Config parsing and validation:
- [x] Daemon/shared/cli/user config stores load/ensure/save.
- [x] Unknown key/type rejection.
- [x] Logging level validation by scope.
- [x] Path resolution:
- [x] Default daemon/shared/cli roots and derived paths.
- [x] Status/control/sessions/workspace registry/template default paths.
- [x] Init scaffolding:
- [x] Creates all required directories and files under new layout.
- [x] Idempotent second run.
- [x] CLI extraction:
- [x] `kato --version` uses CLI manifest version.
- [x] Commands still parse/route/execute correctly from `apps/cli`.
- [x] Control queue behavior:
- [x] Enqueue/list/markProcessed works at shared IPC path.
- [x] No queue hardening behavior change asserted in this task.
- [x] Export behavior:
- [x] CLI sends resolved payload fields.
- [x] Daemon fallback to shared config when fields missing.
- [x] Daemon fails closed if shared fallback unavailable/invalid.
- [x] Status:
- [x] Snapshot includes daemon version.
- [x] Top line matches exact dual-version format.
- [x] Launcher:
- [x] Detached launcher spawns daemon-only entrypoint path.
- [x] Permissions/args/env still correct.
- [x] End-to-end:
- [x] Start/stop/status/export/clean/user/workspace flows all pass under new layout.

## Assumptions and Defaults
1. Single-user local deployment is primary target for this task.
2. Queue contention hardening is intentionally deferred.
3. Shared control queue remains single-file JSON for now.
4. CLI config includes logging only in this phase.
5. Strict CLI/daemon code independence is required in this phase.
6. This task is intentionally breaking; manual migration is required and documented.
