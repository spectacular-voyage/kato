---
id: 5pwg2idztnftvedqh3sqc7f
title: Codebase Overview
desc: ''
updated: 1771787453943
created: 1771787449702
---

## Monorepo Layout

- `apps/daemon`: daemon runtime, CLI, policy, writer pipeline, observability, feature flags.
- `apps/web`: web app placeholder for read-only status surfaces.
- `apps/cloud`: cloud app placeholder for centralized config/aggregation.
- `shared/src`: shared contracts/types for status, IPC envelopes, config, and messages.
- `tests`: contract and behavior tests for daemon, parser, policy, writer, and runtime boundaries.

## Daemon Entry Points

- `apps/daemon/src/main.ts`
  - CLI mode: `kato <command>` via `runDaemonCli`.
  - Subprocess mode: `kato __daemon-run` via `runDaemonSubprocess`.
- `runDaemonSubprocess` is fail-closed:
  - loads runtime config first
  - on load/validation failure, writes startup error and exits non-zero
  - only enters `runDaemonRuntimeLoop` after config + feature evaluation succeed

## Current CLI Surface

- `init`: initialize runtime config if missing.
- `start`: detached launcher start; auto-init optional (`KATO_AUTO_INIT_ON_START`, default true).
- `stop`: queue stop request or reset stale status.
- `status`: render status text or `--json`.
- `export <session-id> [--output path]`: queue one-off export request.
- `clean`: queue cleanup request (`--all` or scoped retention flags).

Implementation:

- Parser/usage/router: `apps/daemon/src/cli/parser.ts`, `apps/daemon/src/cli/usage.ts`, `apps/daemon/src/cli/router.ts`.
- Command handlers: `apps/daemon/src/cli/commands/`.

## Runtime Control Plane

- Status file store: `apps/daemon/src/orchestrator/control_plane.ts` (`status.json`).
- Control queue store: `apps/daemon/src/orchestrator/control_plane.ts` (`control.json`).
- Runtime loop: `apps/daemon/src/orchestrator/daemon_runtime.ts`.

Control request behavior:

- Runtime polls control queue and processes commands.
- `export` requests are routed through recording/writer pipeline.
- Export can be feature-disabled (`daemonExportEnabled`).
- Provider-aware export path exists (`loadSessionSnapshot`) with fallback loader (`loadSessionMessages`).

## Runtime Config And Feature Flags

- Runtime config contract: `shared/src/contracts/config.ts`.
- Runtime config store and validation: `apps/daemon/src/config/runtime_config.ts`.
- Config includes:
  - `runtimeDir`, `statusPath`, `controlPath`
  - `allowedWriteRoots`
  - `featureFlags`

Feature flags:

- Baseline OpenFeature module: `apps/daemon/src/feature_flags/openfeature.ts`.
- Current flags:
  - `writerIncludeThinking`
  - `writerIncludeToolCalls`
  - `writerItalicizeUserMessages`
  - `daemonExportEnabled`
- Unknown `featureFlags` keys are rejected (fail-closed).

## Policy Layer

- In-chat command detection: `apps/daemon/src/policy/command_detection.ts`.
- Write-path policy gate: `apps/daemon/src/policy/path_policy.ts`.
- Path decisions are audited and enforced before writer actions.

## Writer Pipeline

- Frontmatter utilities: `apps/daemon/src/writer/frontmatter.ts`.
- Markdown render/write implementation: `apps/daemon/src/writer/markdown_writer.ts`.
- Recording orchestration: `apps/daemon/src/writer/recording_pipeline.ts`.

Key behavior:

- `::record` starts/rotates active stream.
- `::capture` is one-shot overwrite snapshot and does not rotate active stream.
- append dedupe guard prevents repeated tail writes.
- recording IDs are stream IDs, not provider session IDs.

## Provider Parsers

- Claude parser: `apps/daemon/src/providers/claude/parser.ts`.
- Codex parser: `apps/daemon/src/providers/codex/parser.ts`.
- Shared message contract: `shared/src/contracts/messages.ts`.

Note: full provider ingestion/watching loop is not fully wired yet; parser contracts are covered by fixture tests.

## Tests

- Core runtime and control-plane tests:
  - `tests/daemon-cli_test.ts`
  - `tests/daemon-control-plane_test.ts`
  - `tests/daemon-runtime_test.ts`
  - `tests/daemon-main_test.ts`
- Policy/parser/writer tests:
  - `tests/command-detection_test.ts`
  - `tests/path-policy_test.ts`
  - `tests/claude-parser_test.ts`
  - `tests/codex-parser_test.ts`
  - `tests/recording-pipeline_test.ts`
  - `tests/writer-markdown_test.ts`
  - `tests/runtime-config_test.ts`

## Known MVP Limits

- Startup status is optimistic until heartbeat confirms liveness window.
- Export still depends on a wired session loader in runtime.
- Provider identity for export falls back to `"unknown"` unless provider-aware loader is supplied.
