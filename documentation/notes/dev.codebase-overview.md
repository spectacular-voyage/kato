---
id: 5pwg2idztnftvedqh3sqc7f
title: Codebase Overview
desc: ""
created: 1771787449702
---

## Purpose

This note explains Kato's current architecture after CLI/daemon/web separation:

- process and package boundaries
- ownership of config/state files
- control/data flow between CLI, web, and daemon
- where to extend behavior safely

Related notes:

- [[dev.general-guidance]]
- [[dev.security-baseline]]
- [[dev.deno-daemon-implementation]]

## Core Vocabulary

- **CLI process**: short-lived command process (`apps/cli`) that parses user
  intent and reads/writes config, status, and control-plane files.
- **Daemon process**: long-running ingest/export orchestrator (`apps/daemon`)
  launched by CLI and acknowledged via status heartbeat.
- **Web app process**: local authenticated operator console (`apps/web`) that
  renders browser views from status/config/session/log stores and owns a small
  set of guided local workflows.
- **Runtime library**: shared Deno implementation package (`apps/runtime`) used
  by both CLI and daemon (stores, resolvers, policy, observability).
- **Contracts library**: pure shared contracts (`shared/src`) used across app
  boundaries.
- **Control plane**: file-based IPC between CLI and daemon:
  `~/.kato/shared/ipc/daemon-control.json` (requests) and
  `~/.kato/shared/status.json` (status snapshot).
- **Provider session**: provider conversation identity
  (`provider + providerSessionId`) used as the durable state key.
- **Source file**: provider transcript file discovered by ingestion
  (`sourceFilePath`) and parsed into canonical events.
- **Session metadata**: durable per-provider-session state (`*.meta.json`) with ingest cursor, dedupe fingerprints, command cursor/anchor, recording bindings, and an optional provider-declared immediate parent id for recognized sub-conversations.
- **SessionTwin**: canonical per-provider-session event log (`*.twin.jsonl`) for
  replay and opt-in persisted conversation history.
- **Runtime snapshot**: bounded in-memory projection of parsed events used by
  status, in-chat command handling, and export.
- **First-seen provider session**: daemon has no prior command cursor/anchor
  state for that provider session key.
- **First-seen source file**: source file newly observed/fresh by filesystem
  signals; not equivalent to first-seen provider session.

## Monorepo Boundaries

- `apps/cli/src`: command parser/router and command handlers.
- `apps/daemon/src`: daemon bootstrap + orchestrator + provider parsers.
- `apps/runtime/src`: shared Deno runtime modules (config stores/path
  resolvers/control-plane/policy/workspace/observability).
- `apps/runtime/src/workspace/output_paths.ts`: pure workspace directory and filename template rendering shared by daemon and web. The daemon's `runtime_workspace_paths.ts` remains a compatibility re-export; web code must import the runtime owner rather than daemon internals.
- `shared/src`: contracts and projection utilities (`config`, `status`,
  `session_state`, `events`, `messages`, `ipc`, etc.), including
  `output_metadata.ts` resolvers for effective output metadata/effective tags/effective writer feature flags and `tags.ts` validation/suggestion helpers.
- `apps/web`: local Fresh-based operator console (routes, loaders, API
  handlers, islands, auth/session handling, and small guided workflows).
- `apps/cloud/src`: placeholder.
- `tests`: behavior and contract coverage.

## Web Route Map

Current top-level web routes are:

- `/`: Summary dashboard. Server-rendered first paint plus the `SummaryLive`
  island, backed by `loadSummaryPageData()` and `/api/summary`.
- `/sessions`: primary discovered chat-session inventory, backed by `loadSessionsPageData()` and `/api/sessions`, with live activity, recording state, per-row persisted twin size, creation-time output title/filename/tag controls, on-demand snippet reveal, and URL-driven activity/workspace filters. Sessions always renders provider-declared Claude and Codex children in recursive, default-closed parent trees; legacy `subagents` query parameters are ignored.
- `/sessions/:sessionId`: read-only persisted-twin content viewer backed by `loadSessionTwinViewData()` (`apps/web/src/loaders/session_twin_view.ts`) over the bounded `readTwinEventsWindow` store reader — seq-cursor paging (count and byte caps), canonical twin-path resolution from session identity, fail-closed re-redaction of every served page, messages expanded with other twin kinds collapsed, escaped plain-text rendering only. Linked from `/sessions` (twin `View`) and `/recordings` rows.
- `/recordings`: latest recording-output state across sessions and workspaces (one row per output file, with output tag editing plus stop / same-path `Re-start` for persisted rows), backed by `loadRecordingsPageData()` and `/api/recordings`.
- `/workspaces`: workspace register/unregister, operator-facing display-label editing, registration-time display-label entry, per-workspace preferred-username overrides, shared workspace config edit links, plus workspace-level recording rollups, backed by `loadWorkspacesPageData()` and `/api/workspaces`.
- `/workspaces/:workspaceId/edit`: shared `.kato-workspace-config.yaml` editor for workspace fields (`autoRecordConversations`, `defaultOutputDir`, `filenameTemplate`, `workspaceTimezone`, `defaultTags`, `tagSuggestions`, markdown frontmatter toggles, and workspace writer flags), backed by `loadWorkspaceConfigEditPageData()` and `handleWorkspaceConfigEditPost()`.
- `/logs`: combined daemon + web operational/security log view with shared
  filter semantics, backed by `loadLogPageData()` and `/api/logs`.
- `/settings`: guided user-default, workspace-username mapping, and personal tag suggestion workflows.
- `/maintenance`: guided cleanup workflows for logs and old derived session
  artifacts, plus the persisted twin troubleshooting/cleanup surface backed by
  `loadMaintenanceTwinsData()` and `/api/maintenance-twins`.
- `/login` and `/logout`: local auth/session entry points.

Supporting web files worth knowing:

- `apps/web/src/loaders/*`: filesystem-backed read models used by routes and API
  handlers.
- `apps/web/src/session_recording_actions.ts`: shared web mutation flows for Sessions and Recordings recording/capture start-stop-`Re-start` actions, including creation-time output metadata (`displayTitle`/`filenameSlug`/`tags`) and same-file exclusivity guards.
- `apps/web/src/workspace_config_edit_actions.ts` and `apps/web/src/loaders/workspace_config_edit.ts`: shared web mutation and read-model plumbing for the workspace config editor.
- `apps/web/src/session_metadata_actions.ts`: lock-guarded mutations for session-level output metadata defaults, per-output metadata (`displayTitle`/`filenameSlug`/`tags`/persona fields), and per-output writer flag overrides, with best-effort metadata-only markdown frontmatter sync. Tag edits replace the effective frontmatter tag list while writer appends remain accretive.
- `apps/web/src/output_writer_policy.ts` + `apps/web/src/writer_policy_controls.tsx`: default/override/effective writer-policy projection and the compact tri-state (default/include/exclude) controls rendered on Recordings rows.
- `apps/web/src/session_routes.ts`: canonical href builders for `/maintenance`, `/sessions`, and session anchor links, including composition of Sessions activity and workspace filters.
- `apps/web/src/page_queries.ts`: validated URL-query projections for Sessions, Recordings, and Logs. Sessions uses the base activity/workspace query projection, so legacy `subagents` parameters have no effect.
- `apps/web/src/format_bytes.ts`: deterministic byte-unit formatting shared by Summary memory metrics and Sessions twin-size labels.
- `apps/web/src/session_tree.ts`: browser-safe recursive Sessions tree construction, subtree ordering/summaries, unlinked/cycle handling, and ancestor lookup for deep links.
- `apps/web/src/live_routes.ts`: shared live JSON handlers for
  `/api/chrome-status`, `/api/summary`, `/api/maintenance-twins`,
  `/api/sessions`, `/api/recordings`, `/api/session-snippet`,
  `/api/workspaces`, and `/api/logs`.
- `apps/web/routes/api/*`: thin route entrypoints that delegate to
  `apps/web/src/live_routes.ts`.
- `apps/web/src/api_response.ts`: shared no-store response helper for live JSON
  endpoints.
- `apps/web/src/session_snippets.ts`: shared on-demand snippet resolution from
  live snapshot, twin replay, or explicit provider-source replay.

## Default Filesystem Layout

- `~/.kato/kato-user-config.yaml`
- `~/.kato/shared/kato-shared-config.yaml`
- `~/.kato/shared/status.json`
- `~/.kato/shared/ipc/daemon-control.json`
- `~/.kato/shared/daemon-control.json` (rebuildable session index cache)
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
- `~/.kato/web/kato-web-config.yaml`
- `~/.kato/web/kato-web-status.json`
- `~/.kato/web/logs/operational.jsonl`
- `~/.kato/web/logs/security-audit.jsonl`

The web config stores the preferred local host/port. `kato web start` selects
the effective port at launch time, scanning upward when the preferred port is
already in use; under WSL it also performs a best-effort Windows localhost
listener probe for browser-visible port conflicts. The web status file is the
source of truth for the actual running or stale web URL.

Workspace-local config remains `<workspace>/.kato-workspace-config.yaml`.
Captured/exported conversation files are workspace-root data and do not belong
under `~/.kato` by default.
Generated defaults derived from workspace `defaultOutputDir` remain
workspace-root-contained after template expansion; only explicit command paths
may target outside the workspace root.
Workspace-local `workspaceFeatureFlags` also carry recording-render policy,
including default-on relative sanitization for absolute local inline markdown
destinations plus an optional Dendron wikilink rewrite for local `.md` note
links in workspace-scoped markdown output. Dendron rewriting is vault-aware:
runtime discovery walks upward from the final output path to a matching
`dendron.yml`, derives `wikilinkifiableRoots` from its mounted vaults, and
falls back to the output file's own directory when no Dendron context matches.
When a recording append touches an existing markdown file, the writer also
normalizes the already-written body through that same link-policy pass so
legacy standard note links collapse to Dendron wikilinks once the workspace
flag is enabled. Twins and persisted source/history snapshots stay
authoritative. The Workspaces page exposes the matched
`dendron.yml` path plus the derived roots as read-only diagnostics for the
workspace default output location.
Operator-facing workspace `displayName` labels live in the shared workspace registry, while preferred per-workspace participant usernames and personal tag suggestions remain in `kato-user-config.yaml`.
Kato Web edits shared workspace config through the runtime `updateWorkspaceConfig()` helper, which validates via the workspace config schema, writes atomically, preserves omitted fields for partial programmatic updates, and serializes supported keys back to canonical YAML when a web edit saves.

## Topology

```mermaid
graph TD
  subgraph User
    U[User Shell / Browser]
  end

  subgraph CLIProcess[CLI Process apps/cli]
    PARSE[parse args + route]
    CMDS[command handlers]
    LCH[detached launcher]
  end

  subgraph WebProcess[Web Process apps/web]
    WEB[Fresh routes + loaders + islands]
  end

  subgraph DaemonProcess[Daemon Process apps/daemon]
    MAIN[runDaemonSubprocess]
    LOOP[runDaemonRuntimeLoop]
    INGEST[provider ingestion runners]
    SNAP[session snapshot store]
    PERSIST[persistent session state]
    WRITE[recording pipeline]
  end

  subgraph FS[Filesystem ~/.kato]
    DCFG[daemon/kato-daemon-config.yaml]
    SHCFG[shared/kato-shared-config.yaml]
    CCFG[cli/kato-cli-config.yaml]
    UCFG[kato-user-config.yaml]
    CTRL[shared/ipc/daemon-control.json]
    STAT[shared/status.json]
    SIDX[shared/daemon-control.json]
    SESS[shared/sessions/*.meta.json + *.twin.jsonl]
    WREG[shared/workspace-registry.json]
    WTPL[shared/default-kato-workspace-config.yaml]
    DLOG[daemon/logs/*.jsonl]
    CLOG[cli/logs/*.jsonl]
    WCFG[web/kato-web-config.yaml]
    WSTAT[web/kato-web-status.json]
    WLOG[web/logs/*.jsonl]
  end

  U --> PARSE
  U --> WEB
  PARSE --> CMDS
  CMDS --> DCFG
  CMDS --> SHCFG
  CMDS --> CCFG
  CMDS --> UCFG
  CMDS --> WREG
  CMDS --> WTPL
  CMDS --> CTRL
  CMDS --> STAT
  CMDS --> CLOG
  CMDS --> LCH
  WEB --> WCFG
  WEB --> WSTAT
  WEB --> STAT
  WEB --> WREG
  WEB --> SESS
  WEB --> DLOG
  WEB --> WLOG

  LCH --> MAIN
  MAIN --> DCFG
  MAIN --> SHCFG
  MAIN --> UCFG
  MAIN --> LOOP

  LOOP --> INGEST
  LOOP --> SNAP
  LOOP --> PERSIST
  LOOP --> WRITE
  LOOP --> CTRL
  LOOP --> STAT
  PERSIST --> SESS
  PERSIST --> SIDX
  LOOP --> DLOG
```

## Responsibility Map

| Area                | Primary responsibility                                                                                 | Key modules                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| CLI surface         | Parse commands, load/init CLI+daemon+shared config, enqueue control requests, render status            | `apps/cli/src/*`                                       |
| Web app             | Render authenticated operator views, serve local JSON endpoints, and run small guided workflows        | `apps/web/{routes,islands,src}/*`                      |
| Launcher            | Spawn daemon with narrowed read/write permissions and env overrides                                    | `apps/runtime/src/orchestrator/launcher.ts`            |
| Daemon bootstrap    | Load daemon/shared/user config, init loggers/stores, enter runtime loop                                | `apps/daemon/src/main.ts`                              |
| Control plane       | Persist/list/mark control requests, persist/load status snapshots                                      | `apps/runtime/src/orchestrator/control_plane.ts`       |
| Provider ingestion  | Discover/watch provider source files, parse incremental events, and project provider-session snapshots | `apps/daemon/src/orchestrator/provider_ingestion.ts`   |
| Session persistence | Authoritative provider-session metadata/twin writes and rebuildable daemon index cache                 | `apps/runtime/src/orchestrator/session_state_store.ts` |
| Writer pipeline     | Render markdown/jsonl with policy gate enforcement                                                     | `apps/daemon/src/writer/*`                             |
| Workspace layer     | Registry + workspace profile/template resolution                                                       | `apps/runtime/src/workspace/*`                         |
| Secrets redaction   | Default-on secrets detection/redaction applied to parsed events at ingestion and source replay         | `apps/runtime/src/policy/secrets_*.ts`                 |
| Observability       | Structured operational/audit events for CLI, daemon, and web                                           | `apps/runtime/src/observability/*`                     |

## Daemon Subsystems

### 1) CLI Router and Command Handlers

`runDaemonCli` in `apps/cli/src/router.ts` coordinates:

1. parse intent
2. load/initialize daemon/shared/cli config stores
3. build command context (stores, launcher, policy gate, loggers)
4. dispatch command handler

Most commands enqueue control requests or read status. `clean` is CLI-owned and
executes immediately.

### 2) Detached Launcher Permission Envelope

`DenoDetachedDaemonLauncher` computes runtime-scoped permission roots:

- write: allowed write roots + runtime/config/status/control parents
- read: write roots + daemon source/import roots + `~/.kato` user config dir +
  provider session roots

This keeps the daemon process scoped tighter than broad `-A`.

### 3) Runtime Loop

`runDaemonRuntimeLoop`:

1. marks daemon running in status
2. starts ingestion runners
3. on each poll cycle:
   - polls ingestion
   - applies in-chat command updates
   - consumes control queue requests
   - updates recording summary
   - persists heartbeat/status snapshot
4. stops ingestion and writes terminal status

### 4) Ingestion and Snapshot Projection

Ingestion runners:

- discover/watch provider source files
- resume by provider session identity + persisted cursor
- parse incremental events
- persist metadata and project into in-memory snapshot store
- append SessionTwin with bounded dedupe only when twin persistence is enabled
  for the provider or the user explicitly requests `create twin` / `update twin`

Hot paths use `listMetadataOnly()` to avoid deep-cloning event arrays.

Reconstructed session snippets (the fallback operator-facing session labels)
reflect the conversation's first user message: when a snapshot is created from
a mid-file resume without twin hydration, the runner does a one-time bounded
read of the source-file head (cached per run, secrets policy applied) instead
of letting the label drift to the first post-restart message. Provider titles
(below) take precedence over reconstructed snippets whenever they exist.

Claude additionally maintains its own session titles as `custom-title` (user rename) and `ai-title` (auto-generated) transcript lines. The Claude parser yields them as title-update parse items (they advance the cursor like events), ingestion stores the latest per source with custom outranking ai (`providerTitle`/`providerTitleSource` on snapshot and persisted session metadata, secrets policy applied), and status projection prefers the provider title over the reconstructed snippet in the status `snippet` field, marking its origin in `titleSource`. Sessions whose cursor already passed their title lines get a one-time cached full-file backfill scan.

Freshly parsed events pass the shared secrets policy
(`apps/runtime/src/policy/secrets_redaction.ts`) before snapshot projection,
twin append, or snippet extraction — and the same transform guards
provider-source replay — so every derived artifact (twins, recordings,
snippets, `status.json`) only ever sees redacted content. The policy comes
from `secretsPolicy` in the shared behavior config and defaults to `redact`
(fail closed) when absent; see [[dev.security-baseline]].

When a session has no usable twin history after restart, full-history
`capture` / `export` replay comes from the provider source file on demand
instead of persisted twin events. For Codex sessions, those replayed historical
timestamps may be less precise than live-captured or auto-twinned events.

### Naming Guardrail

- Use **provider session** for identity/cursor/anchor state.
- Use **source file** for filesystem freshness (`birthtime`/`mtime`) and parser
  input context.
- Avoid plain **session** in new replay/freshness comments when it could mean
  either provider-session identity or source-file state.

### 5) Export/Writer Path

`kato export` flow:

1. CLI enqueues `export` request into shared control queue
2. daemon resolves session snapshot
3. writer pipeline enforces path policy
4. writer emits markdown or JSONL
5. request is marked processed

Missing/invalid/empty snapshots fail safe (no silent empty writes).

## Current Web Live Refresh Model

- Summary, Sessions, Recordings, Workspaces, Logs results, Maintenance twin results, and the shared app-header status render server-provided initial data and then poll their corresponding no-store JSON endpoints through `usePolledJson()`.
- Live islands keep the last good render if a poll fails. Page filters remain URL-driven, and each filtered endpoint receives the same query string as the initial page request.
- Settings and bounded edit forms remain server-rendered and use post/redirect/get mutation flows where applicable.
- New live-expansion work should preserve route/query semantics rather than inventing separate client-only filter state. Mutation forms on filtered pages must carry enough hidden state for their redirect to restore the same view.

## Source-of-Truth Boundaries

- `~/.kato/daemon/kato-daemon-config.yaml`: daemon process settings.
- `~/.kato/shared/kato-shared-config.yaml`: shared policy + plain export
  defaults.
- `~/.kato/cli/kato-cli-config.yaml`: CLI-only settings (currently logging).
- `~/.kato/shared/ipc/daemon-control.json`: queued daemon commands.
- `~/.kato/shared/status.json`: externally readable daemon status snapshot.
- `~/.kato/web/kato-web-config.yaml`: local web bind/auth configuration.
- `~/.kato/web/kato-web-status.json`: local web process runstate heartbeat.
- provider source files (Codex/Claude/Gemini transcript files): external inputs,
  not authoritative control state.
- `~/.kato/shared/sessions/*.meta.json` + `*.twin.jsonl`: durable session
  metadata plus opt-in persisted twin history.
- in-memory snapshot store: runtime projection cache.
- markdown/jsonl exports: derived artifacts.

Privacy cleanup note:

- shutdown cleanup may still remove twin files, but snippet privacy no longer
  depends on cleanup because snippets are not persisted in durable session
  metadata.

Page-level web source-of-truth guidance:

- Summary and app-chrome status read primarily from `~/.kato/shared/status.json`
  plus recent daemon/web log tails.
- `Twins`, `Sessions`, `Recordings`, and most workspace recording details
  come from persistent session metadata/twin state under
  `~/.kato/shared/sessions/*`, with the current daemon snapshot merged in where
  live runtime status exists.
- Sessions projects optional `twinSizeBytes` from the existing twin-existence stat and exposes only that path-free numeric metric. `Twin absent` means no recognized persisted twin history; Maintenance remains the surface for twin paths, freshness, troubleshooting, and cleanup.
- `Workspaces` additionally depends on
  `~/.kato/shared/workspace-registry.json`,
  workspace-local `.kato-workspace-config.yaml`, shared behavior config, and
  user settings for workspace-username mappings.
- `Logs` reads both daemon and web log files and applies filtering at load time;
  it is not a projection of `status.json`.

## Extension Guide

To add a provider:

1. add parser under `apps/daemon/src/providers/<provider>/`
2. add provider root in daemon config defaults/contracts
3. wire ingestion runner factory
4. add parser + ingestion tests
5. verify launcher read-scope includes provider roots

To add a control command:

1. extend CLI parser/intent/usage
2. enqueue typed payload to control plane
3. implement daemon runtime handling + audit/operational events
4. add CLI + daemon loop tests for success and fail-closed paths

## Current Limits

- control plane is local file IPC; no remote orchestration
- web console is local-only and auth-gated; it is not a remote multi-user
  control plane
- service-manager integration is deferred
- queue hardening beyond single-file JSON is tracked separately
