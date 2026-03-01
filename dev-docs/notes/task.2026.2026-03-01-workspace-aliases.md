---
id: t3lfa9r314byjwjoga3d5qe
title: 2026 03 01 Workspace Aliases
desc: ''
updated: 1772395927887
created: 1772395927887
---

# Workspace Aliases

Supersedes [task.2026.2026-02-28-session-attach.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-28-session-attach.md).

## Goal

Provide per-workspace recording defaults without hidden per-session attachment
state.

The primary UX should let users direct in-chat recording commands to an
explicit registered workspace alias, while preserving:

- one host-global Kato daemon
- one canonical session metadata store
- one canonical twin store
- one canonical provider-ingestion path

The daemon/runtime root should remain `~/.kato/` by default (subject to the
existing env/config overrides), and it should remain the only place that owns
persisted session state.

## Problem Statement

The session-attach design solved the storage topology problem but kept a poor
interaction model:

- relative in-chat paths depended on hidden attachment state
- users inside the chat could not easily tell what workspace was attached
- explicit CLI attach required a session lookup step
- the model still centered too much of the UX on out-of-band state

The real product need is not "a session has an attached workspace." The real
need is:

- users can target a known workspace explicitly from inside the chat
- users can keep multiple workspace-scoped recordings going in one session
- routing remains unambiguous and visible at the command site
- per-workspace defaults still shape generated destinations and writer behavior

This means the user-facing primitive should be a **workspace alias**, not a
hidden session attachment.

## Core Decision

Keep the one-daemon model, but replace session attachment with
alias-qualified in-chat commands.

- `workspaceId` is the durable identity for a registered workspace.
- `alias` is the user-facing command selector for that workspace.
- `alias` may change over time.
- `workspaceRoot` may change over time.
- The daemon should treat alias and root updates as **restart-bound** changes:
  persisted config/registry may change immediately, but the live daemon keeps
  using the old mapping until the next restart.
- A session may have at most **one active recording per `workspaceId`**.
- The same `workspaceId` may still have simultaneous active recordings in other
  sessions.
- `workspaceAttachment` is no longer the primary model and should be removed.
- `primaryRecordingDestination` is no longer the primary model and should be
  removed.

This keeps all provider/session durability centralized while moving the routing
decision into the command itself.

## UX Target

1. `kato start` starts the one daemon rooted at `~/.kato` (or the existing
   runtime-dir override).
2. The daemon watches provider session roots globally and remains the only
   owner of canonical session metadata and twins.
3. From inside a project workspace, the user runs `kato workspace init` once if
   local `.kato/kato-config.yaml` does not already exist.
4. The user runs `kato workspace register [--alias <alias>]` to register that
   workspace and assign it a stable `workspaceId`.
5. If `--alias` is omitted, Kato should default the alias to the last path
   segment of `workspaceRoot`, unchanged.
6. If that default alias conflicts with an existing alias, or if that exact
   string cannot be represented by the in-chat alias-suffix grammar, `workspace
   register` should fail closed and require an explicit `--alias`.
7. The daemon picks up registry/config changes only after restart.
8. Inside the chat, the user runs commands such as:
   - `record-myproj`
   - `capture-myproj`
   - `export-myproj`
   - `stop-myproj`
9. A reserved default workspace alias (for example `default`) is available when
   enabled in global config, so `record-default` works like any other
   workspace-targeted command.
10. Bare `stop` stops all active recordings for the current session.
11. Bare `record`, `capture`, and `export` should fail closed in the steady
    state; routing should be explicit.
12. Users may keep multiple active recordings in one session as long as each
    targets a different `workspaceId`.

## Command Model

### CLI Commands

- Keep daemon lifecycle commands as-is:
  - `kato init`
  - `kato start`
  - `kato restart`
  - `kato stop`
  - `kato status`
  - `kato clean`
- Keep/add workspace-management commands:
  - `kato workspace init`
  - `kato workspace register [--alias <alias>]`
  - `kato workspace list`
  - `kato workspace unregister <alias-or-id>`
- Remove user-facing attach management from the primary design:
  - `kato attach`
  - `kato attachments`
  - `kato detach`

`workspace register` becomes the main place where alias, root, config path, and
daemon permission coverage are established.

### In-Chat Commands

Recommended steady-state commands:

- `record-<alias> [<path>]`
- `capture-<alias> [<path>]`
- `export-<alias> [<path>]`
- `stop-<alias>`
- `stop`

Recommended grammar rules:

- `<alias>` is the exact registered alias string used in the suffix form.
- If the default alias derived from the folder name cannot be represented
  safely in that suffix form, `workspace register` should fail closed and
  require an explicit `--alias`.
- Bare `record`, `capture`, and `export` are invalid in the steady state.
- `stop` without an alias stops all active recordings for the session.
- `init` is removed entirely.
- `start` remains invalid; `record-<alias>` is the start/resume command.

The parser must treat `record-myproj` as verb `record` plus alias `myproj`, not
as an unknown single command name.

### Output-Path Semantics

For `record-<alias>`, `capture-<alias>`, and `export-<alias>`:

- if no `<path>` is provided:
  - `record-<alias>` resumes the current active recording for that
    session/workspace when one exists
  - otherwise it generates a destination from that workspace's current output
    profile
- if `<path>` is relative:
  - resolve it against that workspace's current `workspaceRoot` as loaded by
    the daemon at startup
- if `<path>` resolves to a directory:
  - generate the filename inside that directory using the workspace profile
- if `<path>` is an absolute file path:
  - use that exact path

Important distinction:

- workspace-relative destinations should move when `workspaceRoot` changes and
  the daemon restarts
- explicit absolute destinations should remain fixed and should **not** be
  re-rooted
- if a workspace profile's `defaultOutputDir` resolves to an absolute path
  outside the workspace, generated destinations from that profile are also
  fixed absolute destinations and should not move with `workspaceRoot`

## Workspace Registry

Registration must be explicit and keyed by `workspaceId`, not inferred only
from `allowedWriteRoots`.

Recommended persistent registry location:

- `~/.kato/workspace-registry.json`

Recommended shape:

```ts
interface RegisteredWorkspace {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  registeredAt: string;
  updatedAt?: string;
}
```

Recommended semantics:

- `workspaceId` is immutable after first registration.
- `alias` is unique among registered workspaces and may be changed later.
- `workspaceRoot` and `configPath` may be updated later.
- Re-registering the same workspace should preserve `workspaceId` and update
  alias/root/config path when they changed.
- The live daemon should not live-reconcile alias/root changes in the first
  pass; it should continue using the old mapping until restart.
- `workspace list` should show at least `workspaceId`, `alias`, `workspaceRoot`,
  `configPath`, `registeredAt`, and `updatedAt`.

### Default Workspace

Treat the default/global target as a reserved built-in workspace, not as a
special one-off branch in command handling.

Recommended model:

- reserve `workspaceId = "default"`
- expose a configurable alias (defaulting to `default`)
- allow enabling/disabling it in the global config
- define its output profile in the global config
- do not manage it via `workspace unregister`

If the default workspace is disabled, commands that target its alias should fail
closed.

## Recording State Model

The session-state model should stop centering on a single session-global
destination.

Replace the "one primary destination per session" approach with
"one active recording per session/workspace pair."

Recommended key:

- `activeRecordingKey = sessionId + workspaceId`

Recommended recording-scoped workspace binding:

```ts
interface RecordingWorkspaceBinding {
  workspaceId: string;
  workspaceAlias?: string;
  workspaceRoot: string;
  sourceConfigPath?: string;
  resolvedDefaultOutputDir: string;
  filenameTemplate: string;
  writerFeatureFlags: {
    writerIncludeCommentary: boolean;
    writerIncludeThinking: boolean;
    writerIncludeToolCalls: boolean;
    writerItalicizeUserMessages: boolean;
  };
}
```

Recommended destination-binding model:

```ts
interface RecordingDestinationBinding {
  kind: "workspace-relative" | "absolute-explicit";
  relativePathFromWorkspaceRoot?: string;
  absolutePath?: string;
}
```

Key semantics:

- When a recording is started from a workspace-relative or generated target,
  persist the chosen path as `relativePathFromWorkspaceRoot`.
- When a recording is started from an explicit absolute path, persist that
  literal absolute path.
- On daemon restart, workspace-relative recordings should re-resolve against the
  current `workspaceRoot` for that `workspaceId`.
- This means a workspace move can retarget active recordings after restart
  without rewriting each recording entry manually.
- Absolute-explicit recordings must not be moved by workspace-root updates.

This is the main design consequence of the "workspace moves should retarget
after restart" requirement: the persisted recording target cannot be only a
fixed absolute path.

## Workspace Moves And Restart Semantics

Workspace moves are a first-class scenario.

Recommended behavior:

- Updating `workspaceRoot` for an existing `workspaceId` is allowed.
- That update persists immediately in config/registry.
- The live daemon keeps using the old alias/root mapping until restart.
- After restart:
  - new commands for that alias resolve against the new `workspaceRoot`
  - existing active recordings with `workspace-relative` bindings re-resolve
    against the new `workspaceRoot`
  - existing active recordings with `absolute-explicit` bindings remain fixed

This keeps runtime behavior predictable and avoids live mid-stream path changes.

## Carry Forward From Current Work

Keep:

- the one-daemon lifecycle model
- the single host-global session metadata/twin store
- workspace config as a partial output profile
- output-profile synthesis behavior (`defaultOutputDir`, `filenameTemplate`,
  writer flags)
- directory-target and generated-path handling
- UTC+0 filename-token behavior
- the existing control-plane / CLI scaffolding where it helps implementation

Discard or replace:

- session attachment as a user-facing concept
- hidden per-session routing state as the main UX
- `primaryRecordingDestination` as the central session-global pointer
- `attach`, `attachments`, and `detach` as primary workflow commands
- `init`

The current attach implementation can be treated as transitional scaffolding,
not the final product direction.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| `record-myproj` with no path starts/resumes the `myproj` recording for this session | Yes | Yes | Yes | Alias-scoped start/resume replaces session-global pointer behavior. |
| `record-myproj notes/foo.md` resolves relative to the registered `workspaceRoot` | Yes | Yes | Yes | Routing is explicit in the command; no hidden attachment state. |
| `record-myproj docs/` generates a filename inside that directory | Yes | Yes | Yes | Directory-target semantics remain shared across command types. |
| `capture-myproj` uses the same alias/path rules and leaves `myproj` active | Yes | Yes | Yes | Capture remains a snapshot-plus-continue workflow. |
| `export-myproj` uses the same alias/path rules but does not affect active recording state | Yes | Yes | Yes | Export remains one-off. |
| `stop-myproj` stops only the `myproj` recording for this session | Yes | Yes | Yes | One active recording per session/workspace keeps this unambiguous. |
| `stop` stops all active recordings for this session | Yes | Yes | Yes | Broad stop remains the only bare command. |
| `record-default` targets the built-in default workspace when enabled | Yes | Yes | Yes | The global/default target is modeled as a reserved workspace, not a special parser exception. |
| Updating `workspaceRoot` for `myproj` and restarting reroots active workspace-relative recordings | Yes | No | No | Persistent state carries a rerootable destination binding; the in-memory path may initially stay simpler. |
| Updating `workspaceRoot` for `myproj` does not move active absolute-explicit recordings | Yes | No | No | Absolute paths remain literal. |

## Implementation Plan

### 1. Reframe the design around aliases

- [ ] Mark the session-attach task as superseded by this alias model.
- [x] Keep one daemon only for ingestion and persisted session state.
- [ ] Remove session attachment as the primary user-facing workflow.
- [ ] Remove `primaryRecordingDestination` as the primary session-global
      recording pointer.

### 2. Add durable workspace registry identity

- [ ] Extend the workspace registry to store immutable `workspaceId`.
- [ ] Require unique aliases.
- [ ] If `workspace register` omits `--alias`, default to the last path segment
      of `workspaceRoot`, unchanged.
- [ ] If that default alias collides, fail and require an explicit `--alias`.
- [ ] If that default alias cannot be represented safely in the alias-suffix
      in-chat grammar, fail and require an explicit `--alias`.
- [ ] Make `workspace register [--alias <alias>]` preserve an existing
      `workspaceId` on re-registration.
- [ ] Allow `workspaceRoot` / `configPath` / alias updates on re-registration.
- [ ] Make alias/root/config updates restart-bound for the live daemon.
- [ ] Surface both `workspaceId` and alias in `workspace list`.

### 3. Add configurable default workspace

- [ ] Model the default/global target as a reserved built-in workspace.
- [ ] Add global config fields for:
  - [ ] default workspace enabled/disabled
  - [ ] default workspace alias
  - [ ] default workspace output profile
- [ ] Fail closed when the default workspace is disabled and its alias is
      targeted.

### 4. Replace the in-chat grammar

- [ ] Remove `init`.
- [ ] Keep `start` invalid.
- [ ] Add alias-qualified command parsing:
  - [ ] `record-<alias> [<path>]`
  - [ ] `capture-<alias> [<path>]`
  - [ ] `export-<alias> [<path>]`
  - [ ] `stop-<alias>`
- [ ] Keep bare `stop` as "stop all active recordings for this session".
- [ ] Make bare `record`, `capture`, and `export` fail closed in the
      steady-state grammar.

### 5. Rework recording state around session + workspace

- [ ] Enforce at most one active recording per `sessionId + workspaceId`.
- [ ] Persist recording-scoped workspace binding (`workspaceId`, alias snapshot,
      root snapshot, config snapshot, writer flags).
- [ ] Persist destination bindings as either:
  - [ ] `workspace-relative`
  - [ ] `absolute-explicit`
- [ ] Remove or migrate away from `workspaceAttachment`.
- [ ] Remove or migrate away from `primaryRecordingDestination`.

### 6. Support rerootable destinations

- [ ] When a workspace-scoped recording starts from a generated or relative
      path, persist the chosen target as `relativePathFromWorkspaceRoot`.
- [ ] When a workspace-scoped recording starts from an explicit absolute path,
      persist it as a literal absolute destination.
- [ ] On daemon restart, re-resolve workspace-relative active recordings
      against the current `workspaceRoot`.
- [ ] Do not re-root absolute-explicit recordings.
- [ ] Ensure absolute `defaultOutputDir` values outside the workspace produce
      absolute-explicit destinations.

### 7. Route command execution through workspace aliases

- [ ] Replace session-attachment lookup with alias -> `workspaceId` lookup.
- [ ] Resolve workspace config/profile in the daemon from the current registry
      view loaded at startup.
- [ ] Use the same output-path resolution rules for `record`, `capture`, and
      `export`.
- [ ] Keep final write-policy enforcement through `allowedWriteRoots`.
- [ ] Make `stop-<alias>` stop only that workspace recording for the current
      session.
- [ ] Make `stop` stop all active recordings for the current session.

### 8. Simplify dynamic refresh scope

- [ ] In the first pass, do not live-apply alias/root changes without restart.
- [ ] Decide whether in-place workspace config content changes are also
      restart-bound in the first pass.
- [ ] Document the restart boundary clearly for:
  - [ ] alias changes
  - [ ] workspace-root changes
  - [ ] config-path changes

### 9. Migrate or remove superseded commands and state

- [ ] Remove `attach`, `attachments`, and `detach` from the primary CLI docs.
- [ ] Decide whether to:
  - [ ] fully remove the current attach implementation, or
  - [ ] temporarily keep it behind a deprecated/internal path during migration
- [ ] Add metadata migration rules for old persisted `workspaceAttachment`
      state.
- [ ] Add metadata migration rules for old `primaryRecordingDestination`
      state.

### 10. Tests

- [ ] Add parser tests for alias-qualified in-chat commands.
- [ ] Add parser tests showing bare `record`, `capture`, and `export` are
      rejected.
- [ ] Add registry tests for immutable `workspaceId` and alias uniqueness.
- [ ] Add CLI tests for `workspace register [--alias <alias>]`.
- [ ] Add CLI tests for omitted-`--alias` defaulting to the raw folder name.
- [ ] Add CLI tests showing invalid default aliases fail and require explicit
      `--alias`.
- [ ] Add CLI tests showing re-register updates alias/root/config while keeping
      `workspaceId`.
- [ ] Add runtime tests for one active recording per `sessionId + workspaceId`.
- [ ] Add runtime tests for multiple simultaneous workspaces in one session.
- [ ] Add runtime tests for the same `workspaceId` recording in multiple
      sessions at once.
- [ ] Add runtime tests for `stop-<alias>`.
- [ ] Add runtime tests for bare `stop` stopping all recordings in the session.
- [ ] Add runtime tests for restart-bound alias/root changes.
- [ ] Add runtime tests showing workspace-relative recordings re-root after
      restart.
- [ ] Add runtime tests showing absolute-explicit recordings do not re-root.
- [ ] Add migration tests for old attach-era metadata.

### 11. Docs

- [ ] Update `README.md` to document the alias-scoped command model.
- [ ] Update `dev.general-guidance.md` to replace the old command grammar.
- [ ] Document the `workspaceId` + alias distinction.
- [ ] Document the reserved default workspace and its config knobs.
- [ ] Document that alias/root changes take effect only after daemon restart.
- [ ] Document the difference between workspace-relative and absolute-explicit
      recording destinations.

## Acceptance Criteria

- [ ] There is still exactly one canonical daemon-owned session-state/twin
      store per host.
- [ ] Workspace routing is explicit in the in-chat command itself.
- [ ] Users do not need hidden session attachment state to understand where a
      relative alias-scoped command will write.
- [ ] Registered workspaces have immutable `workspaceId` values and mutable
      aliases.
- [ ] The daemon uses alias/root/config mappings loaded at startup and does not
      live-apply those mapping changes before restart.
- [ ] A session can have at most one active recording per `workspaceId`.
- [ ] Different sessions can record to the same `workspaceId` simultaneously.
- [ ] The default/global target is modeled as a configurable built-in
      workspace.
- [ ] Bare `stop` stops all active recordings for the current session.
- [ ] Bare `record`, `capture`, and `export` fail closed in the steady-state
      grammar.
- [ ] Workspace-relative active recordings re-root after daemon restart when
      that workspace's `workspaceRoot` changed.
- [ ] Absolute-explicit active recordings do not re-root when
      `workspaceRoot` changed.
- [ ] Session attachment is no longer the primary design.
- [ ] `primaryRecordingDestination` is no longer the primary design.

## Risks And Mitigations

- Risk: alias-suffixed command parsing is more specialized than the current
  generic command-name parser.
  Mitigation: keep alias syntax intentionally narrow (`[a-z0-9-]+`) and add
  strict parser tests.

- Risk: automatic rerooting after restart could surprise users who expected a
  recording to stay fixed.
  Mitigation: reroot only `workspace-relative` destinations; keep
  `absolute-explicit` destinations literal.

- Risk: the current attach-era metadata model overlaps awkwardly with the new
  per-recording workspace model.
  Mitigation: treat existing attach-era fields as transitional state and add an
  explicit migration/remove path instead of carrying both models indefinitely.

- Risk: a disabled or renamed default alias could make old habits fail.
  Mitigation: document the reserved default workspace clearly and fail with
  explicit, actionable error messages.
