---
id: vcs43cmgkumrr4f0vkryyjo
title: 2026 02 28 Session Attach
desc: ''
updated: 1772300904824
created: 1772292128450
---

# Session Attach

## Goal

Provide per-workspace defaults for recording behavior, including all configuration knobs that apply to recording-generation, but especially:

- default output location
- filename templating for generated destinations

Do that while keeping a single host-global Kato daemon as the only owner of:

- provider ingestion
- in-memory session snapshots
- persisted session metadata
- persisted session twins

The design should make workspace-local output behavior an explicit per-session
attachment concern, not a daemon-identity concern.

The canonical daemon/runtime root should be `~/.kato/` by default (subject to
the existing env and config overrides), and it should remain the only place that stores
session state.

## Problem Statement

Users need different workspaces to have different recording defaults. The
strongest practical needs are:

- different default output directories
- different generated filename patterns

The current global config at `~/.kato` is a good home for daemon lifecycle and
host-global state, but it is too coarse as the only place to express
project-specific recording/output preferences.

At the same time, there must still be only one canonical twin/metadata set per
host, so you are not processing all conversations multiple times.

If multiple daemons watch the same provider roots, they can all ingest the same
session and independently build:

- duplicate snapshots
- duplicate twins
- divergent session metadata

That is fundamentally wrong for durability, replay, resource usage, and operational clarity.

The deeper issue is that an in-chat command cannot be the mechanism that
*establishes* workspace ownership. A daemon must already be watching that
session to even see the command, so "wait for an in-chat command to figure out
the workspace" is circular.

So the real requirement is:

- support per-workspace recording defaults
- keep one daemon and one canonical session-state/twin store
- make workspace selection explicit at the session level

## Core Decision

Use one daemon only:

- `kato start`, `restart`, `stop`, `status`, and `clean` target the daemon.
- The daemon owns all provider ingestion and all persisted session state.
- Workspace `.kato/kato-config.yaml` files remain useful, but only as
  **workspace output profiles** loaded by the CLI during attach.
- A session may optionally carry an explicit attached workspace profile.
- If no explicit attachment exists, the session uses the **default workspace**,
  which is the daemon's global config context (`~/.kato` in the default
  layout).

This makes "unclaimed session" behavior predictable without losing the
non-workspace convenience path.

## UX Target

1. `kato start` starts the daemon rooted at `~/.kato` (or the existing
   runtime-dir override).
2. The daemon watches provider session roots globally and keeps the one
   canonical session-state/twin store.
3. From inside a project workspace, the user runs `kato workspace init` once if
   local `.kato/kato-config.yaml` does not already exist.
4. The user runs `kato workspace register` to ensure that workspace is covered
   by the daemon's read/write scope, restarting the daemon if required.
5. The user then runs
   `kato attach <session-selector> [--output <path>]`.
6. The CLI resolves the current directory's or nearest ancestor
   `.kato/kato-config.yaml` and treats it as a partial workspace output
   profile.
7. The attachment profile is synthesized by applying workspace overrides first,
   then global config values, then built-in defaults for any still-missing
   output settings.
8. Workspace config values that are daemon-scoped or host-global are discarded
   during attach.
9. `attach` binds that session to a workspace output context and, if
   `--output` is supplied, sets the session recording destination.
10. After attach, generated paths and relative in-chat commands for that session
   use the attached workspace context.
11. If a session is never attached, in-chat commands still work, but they use the
   default workspace context.
12. There is no promise of "auto-record every conversation using workspace
   defaults" before an explicit attach. Workspace-local recording is opt-in.

## Command Model

### CLI Commands

- Keep daemon lifecycle commands as-is:
  - `kato init`
  - `kato start`
  - `kato restart`
  - `kato stop`
  - `kato status`
  - `kato clean`
- Add:
  - `kato workspace init`
  - `kato workspace register`
  - `kato workspace list`
  - `kato workspace unregister`
  - `kato attach <session-selector> [--output <path>]`
  - `kato attachments [--all]`
  - `kato detach <session-selector>`
- Keep:
  - `kato export <session-selector> [--output <path>]`

`attach` is the session-binding operation. Workspace setup should be handled by
separate workspace commands, not folded into `attach`.

Command-name split:

- `kato init` remains the global daemon bootstrap command for `~/.kato`.
- `kato workspace init` is the local workspace scaffolding command.
- They intentionally do different jobs and should not be conflated.

### Workspace Setup

- `kato workspace init` should create a local `.kato/` directory and
  `kato-config.yaml` when missing.
- `kato workspace init` is local scaffolding only. It should not mutate global
  daemon permissions or restart the daemon.
- `kato workspace register` should require a local workspace config.
- As a convenience, `kato workspace register` may call `kato workspace init`
  first if the local config is missing.
- `kato workspace register` should add or update an explicit workspace-registry
  entry for that workspace.
- `kato workspace register` should update the global daemon config so the
  workspace falls within the daemon's permitted roots.
- `kato workspace register` should always ensure `workspaceRoot` is in
  `allowedWriteRoots`.
- If the synthesized `defaultOutputDir` resolves to an absolute path outside
  `workspaceRoot`, `kato workspace register` should also add that resolved
  output root to `allowedWriteRoots`.
- `kato workspace register` should not pre-authorize arbitrary future explicit
  absolute output paths outside those registered roots.
- If registration changes daemon read/write scope and the daemon is running,
  `kato workspace register` should restart the daemon.
- Before auto-restarting or telling the user that a restart is required,
  `kato workspace register` should compare the post-restart
  `allowedWriteRoots` set against currently active recording destinations.
- If any active recording would lose write coverage after restart because an
  earlier unregister cleaned up its root from persisted config, surface a clear
  warning that names the affected session(s) / destination path(s) before the
  restart happens.
- `kato workspace register` should be idempotent when the workspace is already
  registered and covered by the daemon's current config.
- `kato workspace list` should show registered workspaces from the registry,
  including at least `workspaceRoot`, `configPath`, `registeredAt`, and
  `updatedAt` when present.
- `kato workspace unregister` should remove the workspace-registry entry.
- `kato workspace unregister` should leave existing session attachments and
  active recordings untouched; they continue using their last persisted
  attachment profile.
- After unregister, new attach attempts from that workspace should fail until
  the workspace is registered again.
- Unregistering a workspace should stop daemon-side watching for that config
  path once the registry entry is removed.
- `kato workspace unregister` should prune persisted `allowedWriteRoots` entries
  that are no longer needed by any remaining registered workspace.
- That pruning should only remove roots introduced solely to cover the
  unregistered workspace; shared roots must be retained.
- In the first pass, `kato workspace unregister` should not force a daemon
  restart solely for that cleanup. The live daemon keeps its current effective
  permissions until the next restart, but the persisted config stays clean.

## Workspace Registry

Registration should be explicit, not inferred only from `allowedWriteRoots`.

Recommended persistent registry location:

- `~/.kato/workspace-registry.json`

Recommended shape:

```ts
interface RegisteredWorkspace {
  workspaceRoot: string;
  configPath: string;
  registeredAt: string;
  updatedAt?: string;
}
```

Recommended semantics:

- A workspace is "registered" when it has a registry entry, not merely because
  it happens to fall under a broad allowed root.
- `registeredAt` records when the workspace was first registered.
- `updatedAt` may track later re-registration / normalization changes.
- `workspace list` reads from this registry.
- The daemon should read this registry at startup to discover which config
  files are eligible for dynamic watching.
- The daemon should also watch the registry file itself and reconcile the
  per-config watcher set when registry entries are added or removed.
- Because the registry file lives under the daemon's own runtime root, this
  watcher-management path does not require a separate control command.
- Config watchers should be keyed/deduped by `configPath`, not by scanning all
  `allowedWriteRoots` for `.kato/kato-config.yaml`.

### Attachment Management

- `kato attachments [--all]` should list sessions with current attachment state,
  including at least:
  - session selector / id
  - whether the session is using the default workspace or an explicit
    attachment
  - attached `workspaceRoot`
  - `sourceConfigPath` when available
  - current `primaryRecordingDestination` when set
- By default, `kato attachments` should show only sessions with an explicit
  `workspaceAttachment`.
- `kato attachments --all` should also include sessions currently using the
  default workspace (no explicit attachment).
- First pass should keep `kato attachments` as a dedicated command instead of
  overloading `kato status`; `status` may later grow an attachment summary, but
  attachment inspection should have an explicit surface now.
- `kato detach <session-selector>` should clear `workspaceAttachment` for that
  session and return future generated-path behavior to the default workspace.
- Detach should not delete existing recordings or rewrite prior output files.

### In-chat commands

Recommended steady-state in-chat commands:

- `::record [<path>]`
- `::capture [<path>]`
- `::export [<path>]`
- `::stop`

Remove `::init` entirely. No backward-compatibility alias is needed.

`::record` semantics:

- if `<path>` is a file path, set that as the session recording destination and
  start/resume recording
- if `<path>` resolves to a directory, use that directory as the output root and
  generate the filename with the active filename-template rules
- if no `<path>` is provided and the session already has a recording
  destination, start/resume recording there
- if no `<path>` is provided and the session does not yet have a destination,
  generate one from the attached workspace profile when present, otherwise the
  default workspace profile, and fall back to built-in defaults if needed

`::capture` / `::export` semantics:

- `::capture [<path>]` uses the same file-vs-directory-vs-relative path
  resolution rules as `::record [<path>]`
- pathless `::capture` should use the current recording destination when one
  exists, otherwise generate a destination from attached/default/global rules
- `::export [<path>]` uses the same file-vs-directory-vs-relative path
  resolution rules as `::record [<path>]`
- pathless `::export` should generate an output destination from
  attached/default/global rules and must not change the active recording
  destination

This keeps interactive recording control while removing the need for a separate
in-chat init command.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| `::record <file>` sets destination and starts recording | Yes | No | No | This redesign makes pathful `::record` valid and session-scoped. |
| `::record <relative-path>` resolves against the attached workspace root | Yes | No | No | Relative in-chat output paths are now attachment-aware instead of being rejected or forced global. |
| `::record <dir>/` generates filename via template and starts recording | Yes | No | No | New directory-target behavior depends on attachment/default workspace rules. |
| pathless `::record` resumes existing destination | Yes | No | Yes | Same high-level intent: resume current session recording when destination already exists. |
| pathless `::record` without existing destination generates one | Yes | No | No | New generated-path fallback replaces prior `::init`-driven setup. |
| pathless `::capture` uses current destination when available | Yes | No | Yes | Same intent, but resolution is now explicitly aligned with `::record`. |
| pathless `::export` generates destination without altering recording | Yes | No | Yes | Same export intent, with explicit attachment-aware generation. |
| `kato attach` binds a session to a registered workspace profile | Yes | No | No | New persistent-only session-routing capability. |
| `kato attach --output <dir>/` uses template generation inside that directory | Yes | No | No | Directory targets on attach now mirror `record` / `capture` / `export` semantics. |
| `kato detach` returns future generated behavior to default workspace | Yes | No | No | New persistent-only session-routing capability. |
| `kato workspace unregister` leaves existing attachments running | Yes | No | No | New explicit decision: remove registry entry, keep persisted attachments as-is. |

## Attach Semantics

`kato attach <session-selector> [--output <path>]` should:

1. Resolve the target session using the same selector rules as CLI export:
   exact id or a unique short selector, failing closed when ambiguous.
2. Resolve the attachment profile:
   - current directory's or nearest ancestor `.kato/kato-config.yaml`
   - if none exists, fail and direct the user to `kato workspace init` /
     `kato workspace register`
3. Verify that the resolved workspace has a registry entry.
4. If the workspace is not registered, fail and direct the user to
   `kato workspace register`.
5. Load and synthesize the workspace config in the CLI, then send the resolved
   profile to the daemon.
6. Treat the workspace config as partial and synthesize the effective
   attachment profile by merging:
   - workspace output overrides
   - global config output values
   - built-in defaults
7. Discard workspace config keys that are daemon-scoped or host-global.
8. Enqueue an `attach` control request to the daemon.
9. In the daemon, persist the session attachment.

Clarification:

- "Load the workspace config in the CLI, not in the daemon" does **not** mean
  the daemon is unaware of workspace-specific behavior.
- It means the CLI reads the workspace file, synthesizes the effective
  attachment profile, and sends that resolved profile to the daemon.
- The daemon then persists and uses that per-session profile from
  `workspaceAttachment`.
- The daemon should not reopen arbitrary workspace config files on the write
  path; dynamic refresh is handled by registered config watchers.

Recommended default behavior when `--output` is omitted:

- bind the workspace profile only
- leave the current session recording destination unchanged
- if the session has no destination yet, let a later pathless `::record`,
  `::capture`, or `::export` generate one from the attached workspace rules

If `--output` is provided, attach should also resolve that target using the
same path rules as the in-chat commands and set it as the session recording
destination.

### `--output` behavior

Use the same path semantics we want consistently for `record`, `capture`, and
`export`:

- if `--output` is a file path, use that file
- if it resolves to a directory, generate the filename inside that directory
- if it is relative, resolve it against the attached profile's `workspaceRoot`
- final writes still go through the daemon config's `allowedWriteRoots`

## Session Metadata Model

Add an explicit optional attachment block to persisted session metadata.

Recommended shape:

```ts
interface SessionWorkspaceAttachment {
  attachedAt: string;
  sourceConfigPath?: string;
  workspaceRoot: string;
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

This should remain an additive optional field in the first pass. Do not bump
the session-metadata schema version just for `workspaceAttachment`.

Recommended semantics:

- If `workspaceAttachment` is absent, the session uses the default workspace
  (the daemon's runtime config).
- If `workspaceAttachment` is present, it overrides the default workspace for:
  - relative explicit path resolution
  - pathless generated destination resolution
  - writer render behavior for future writes
- `primaryRecordingDestination` remains separate and keeps its current role.
- Re-attaching a session replaces the existing `workspaceAttachment`.
- Re-attach should be "last write wins" and should emit a clear audit log entry
  that includes the previous `workspaceRoot`.
- Detaching a session removes `workspaceAttachment` and returns future
  generated-path behavior to the default workspace.

Important design choice:

- Persist the resolved attachment profile in `workspaceAttachment`.
- The daemon always uses the persisted profile for actual path generation and
  writer behavior.

This keeps the daemon's per-session behavior explicit and durable even if the
source workspace file is temporarily unavailable.

## Dynamic Config Refresh

The first pass should include daemon-side file watching for registered
workspace config files that are already readable. The daemon should refresh the
persisted attachment profile, not treat the workspace file as the live source
of truth on every write.

Recommended model:

- `workspaceAttachment` stores the last resolved profile actually used by the
  daemon.
- The daemon should also watch `workspace-registry.json` and reconcile the
  active `sourceConfigPath` watcher set when registry entries change.
- When `sourceConfigPath` is present and readable, the daemon should watch that
  specific file and re-synthesize the profile on change.
- The daemon should derive the set of watchable workspace config files from the
  workspace registry, not by scanning broad allowed roots.
- On successful reload, the daemon updates `workspaceAttachment` in place for
  all sessions attached to that config path.
- On reload failure (parse error, unsupported schema, permission error), the
  daemon keeps using the last good persisted profile and logs a warning.
- When a config path is not readable under the daemon's current permissions, no
  watcher is installed and explicit `kato attach` / re-attach remains the
  fallback refresh path.
- Registering or unregistering a workspace can therefore add or remove a
  config-file watcher immediately without restarting, as long as the daemon's
  existing read scope already covers that config path.

Behavioral rules:

- changes to `defaultOutputDir` / `filenameTemplate` affect only future
  generated destinations
- changing those values does not move an already-selected active recording path
- changes to `writerFeatureFlags` may affect subsequent appends to an active
  recording

This avoids needing to snapshot writer render flags per recording. Instead,
writer options can be resolved from the current session attachment at write
time.

Important implementation constraint:

- today the daemon subprocess has fixed read permissions at launch, and the
  current recording pipeline bakes writer render defaults at startup
- a live watcher is therefore only practical if attached workspace config files
  are already under the daemon's readable roots
- if a workspace config path is outside the daemon's current readable roots,
  enabling watch-based refresh requires `kato workspace register` to update the
  global daemon config and restart the daemon
- writer-render settings must be resolved per write from session attachment
  state instead of only from global startup config
- when those constraints are not met for a given workspace config path, explicit
  `kato attach` / re-attach remains the fallback refresh mechanism

## Default Workspace Behavior

Sessions without an explicit attachment should still be usable.

Recommended behavior:

- un-attached sessions implicitly use the daemon's global config context
- in the default layout, that means paths resolve relative to `~/.kato`'s
  output root rules
- in-chat `::record`, `::capture`, `::export`, and `::stop` continue to work
  there

This is better than silently ignoring commands on un-attached sessions, and it
preserves the existing "just use Kato without a project workspace" mode.

## Handling Existing Default-Workspace Recordings During Attach

There is a real migration edge case:

- a session may first produce files in the default workspace
- later the user may explicitly attach it to a project workspace

Recommended default behavior:

- **do not delete or rewrite old default-workspace files automatically**
- simply switch future pathless/relative behavior to the attached workspace
- if `attach` creates a new recording destination, make that the new
  `primaryRecordingDestination`

This is the safest default. Silent cleanup is too risky.

Potential follow-on config knob if needed later:

- `cleanupDefaultWorkspaceRecordingsOnAttach?: boolean`

If this is ever added, it should default to `false`, and it should only affect
Kato-managed files that are confidently identified as default-workspace
artifacts. That policy is not needed for the first pass.

## Output-Path Capabilities This Design Still Needs

Session attach only solves workspace selection. It still depends on strong
output-path behavior.

Keep these capabilities in scope:

- `defaultOutputDir` in runtime/workspace config
- `filenameTemplate` in runtime/workspace config
- UTC+0 filename-template date tokens
- `snippetSlug` filename token
- generated-path helper centralization in `output_paths.ts`
- relative explicit path support
- directory-path handling for explicit output targets, including
  `::record [<path>]`
- bare `::export`
- global config template seeding via `~/.kato/kato-config.template.yaml`

Workspace `.kato/kato-config.yaml` should still exist, but it becomes a
workspace output profile read by the CLI during attach, and only the
output-shaping fields from that config should affect an attached session.

## Config-Scope Rules

When the CLI loads a workspace config for attach, it should treat that file as
an incomplete override layer, not a full standalone runtime config.

The effective attachment profile should be synthesized in this order:

1. workspace output overrides
2. global config output values
3. built-in defaults

Only the output-shaping subset plus the supported workspace-scoped writer flags
should be propagated into per-session attachment state.

Recommended attach-time subset:

- `defaultOutputDir`
- `filenameTemplate`
- `featureFlags.writerIncludeCommentary`
- `featureFlags.writerIncludeThinking`
- `featureFlags.writerIncludeToolCalls`
- `featureFlags.writerItalicizeUserMessages`

Possible later additions, only if truly needed:

- `markdownFrontmatter`

Fields that should **not** be imported from the workspace config into
per-session attachment state:

- `runtimeDir`
- `statusPath`
- `controlPath`
- `providerSessionRoots`
- `globalAutoGenerateSnapshots`
- `providerAutoGenerateSnapshots`
- logging config
- memory limits
- `featureFlags.daemonExportEnabled`
- `featureFlags.captureIncludeSystemEvents`
- any other feature flags unrelated to writer rendering

Those keys remain meaningful in the global config, but they should be ignored
when read from a workspace-local config for attach.

This avoids smuggling daemon-runtime behavior through a workspace attachment.

## Security / Permission Rules

- The daemon remains the only process that writes recordings/exports.
- Session attachment must not widen daemon permissions.
- The daemon's global `allowedWriteRoots` remains the hard write boundary.
- The daemon's read scope is also fixed at launch.
- A workspace attachment can influence path generation and relative path
  resolution, but not the allowed root set.
- If an attached workspace points at a path outside the daemon config's
  `allowedWriteRoots`, the write must still be denied.
- If an attached workspace config path is outside the daemon's readable roots,
  the daemon must not attempt to watch or reload it.

Practical consequence:

- `attach` cannot "just add" a new workspace to `allowedWriteRoots` or the
  daemon's readable roots while the daemon is running.
- `kato workspace register` owns permission expansion and daemon restart when
  needed.
- Any command that would trigger or recommend a daemon restart because of a
  changed permission set should warn first if active recordings would be out of
  scope under the post-restart `allowedWriteRoots`.
- `kato workspace unregister` may narrow the persisted `allowedWriteRoots`
  config, but that narrowing does not revoke the already-running daemon's live
  permissions until the next restart.
- `attach` should fail closed if the current workspace does not already have a
  registry entry.

Operational implication:

- the daemon config's `allowedWriteRoots` must already be broad enough to cover
  the workspaces where the user expects Kato to write
- any workspace config files that should be watched dynamically must already be
  under the daemon's readable roots

## Open Edge Cases To Handle Explicitly

- Attach before discovery:
  - if the session is not currently known, the daemon should synchronously force
    one provider-refresh pass before failing closed
  - the CLI should block for up to one discovery interval while waiting for
    that refresh to surface the session
  - anchor that timeout to the daemon's current discovery cadence
    (`DEFAULT_DISCOVERY_INTERVAL_MS`, currently 5 seconds), not to a separate
    hardcoded constant
  - if the session is still unknown after that refresh window, `attach` fails
    closed
- Attach races:
  - two `attach` requests for the same session should be serialized; last write
    wins
- Re-attach from a different workspace:
  - this should be allowed and should overwrite the previous attachment
- Workspace config changes after attach:
  - if the config is watchable, subsequent writes may pick up the change
    automatically
  - otherwise, the user must re-run `attach`
- Attach to a workspace that is not registered:
  - `attach` should fail closed and direct the user to `kato workspace register`
- Workspace list / unregister consistency:
  - unregistering a workspace with attached sessions is allowed
  - it removes the registry entry and stops future watcher-based refresh for
    that config path
  - it prunes persisted `allowedWriteRoots` entries that are no longer needed by
    any remaining registered workspace
  - it does not clear existing `workspaceAttachment` state or stop active
    recordings
- Restart-required register after prior unregister cleanup:
  - if the next `workspace register` would require a daemon restart, the command
    should compare active recording destinations against the post-restart
    `allowedWriteRoots`
  - if any active recording would lose write permission after restart, warn
    before the restart occurs and identify the affected session(s) /
    destination(s)
- No local `.kato` in cwd:
  - `attach` should fail closed and direct the user to `kato workspace init`
    and then `kato workspace register`
- Pathless CLI export:
  - when no explicit `--output` is provided, it should use the attached
    workspace if present, otherwise the default workspace

## Non-Goals

- Do not introduce multiple independent daemon instances just to scope
  workspaces.
- Do not infer workspace ownership from provider session metadata or cwd alone.
- Do not promise automatic workspace-local recording for every new session.
- Do not broaden daemon filesystem permissions just to read random workspace
  configs at runtime.
- Do not keep removed command behavior just for backward compatibility.

## Scope

- [ ] Keep one daemon as the owner of ingestion, snapshots, metadata, and
      twins.
- [ ] Add `kato workspace init`.
- [ ] Add `kato workspace register`.
- [ ] Add `kato workspace list`.
- [ ] Add `kato workspace unregister`.
- [ ] Add a persistent workspace registry with `registeredAt`.
- [ ] Add `kato attach <session-selector> [--output <path>]`.
- [ ] Add `kato attachments` and `kato detach <session-selector>`.
- [ ] Add persisted per-session workspace attachment state.
- [ ] Route pathless and relative commands through attached workspace context
      when present.
- [ ] Allow workspace-scoped writer render feature flags.
- [ ] Support dynamic refresh of attachment profiles when a watched workspace
      config changes; explicit re-attach remains the fallback only for
      non-watchable config paths or reload failures.
- [ ] Make `workspace register`, not `attach`, own daemon permission expansion
      and restart when required.
- [ ] Use the default workspace (`~/.kato`) when no explicit session attachment
      exists.
- [ ] Remove in-chat `::init`.
- [ ] Let in-chat `::record` accept an optional path.
- [ ] Let file or directory targets on `record`, `capture`, `export`, and
      attach `--output` use the filename template when a directory is selected.
- [ ] Keep output-path capabilities in scope (`defaultOutputDir`,
      `filenameTemplate`, relative/directory path support, UTC templating,
      config templates).
- [ ] Keep daemon writes constrained by the daemon config's
      `allowedWriteRoots`.

## Implementation Plan

### 1. Keep daemon lifecycle on one runtime

- [ ] Ensure daemon lifecycle commands (`start`, `restart`, `stop`, `status`,
      `clean`) always target the daemon runtime config.
- [ ] Stop treating workspace-local runtime/status/control paths as separate
      daemon identities.
- [ ] Preserve env overrides (`KATO_RUNTIME_DIR`, `KATO_CONFIG_PATH`) as the
      way to relocate the daemon runtime, not as a workspace-scoping mechanism.
- [ ] Keep read/write permission expansion as a restart boundary, not a live
      attach-side mutation.

### 2. Add workspace setup commands

- [ ] Add `kato workspace init` to create local `.kato/` and
      `kato-config.yaml` when missing.
- [ ] Add a persistent workspace registry file under `~/.kato/`.
- [ ] Add `kato workspace register` to ensure the local config exists, create
      or update the workspace-registry entry, update global daemon config, and
      restart the daemon if permission scope changes.
- [ ] Before any restart triggered by `workspace register`, compare active
      recording destinations against the post-restart `allowedWriteRoots` set
      and surface a warning for any recordings that would lose coverage.
- [ ] Add `kato workspace list` to read and render registry entries.
- [ ] Add `kato workspace unregister` to remove registry entries, stop any
      active watcher for that config path, and prune no-longer-needed persisted
      `allowedWriteRoots` entries without forcing a restart in the first pass.
- [ ] Make `workspace register` idempotent when the workspace is already
      registered and covered by the daemon's current config.

### 3. Add session attachment state

- [ ] Extend the shared session-state contract with an optional
      `workspaceAttachment` block.
- [ ] Update the session metadata validator and clone logic.
- [ ] Keep `workspaceAttachment` as an additive optional field; do not bump the
      session-metadata schema version in the first pass.
- [ ] Persist and reload attachment state in the session-state store.
- [ ] Include workspace-scoped writer feature flags in the persisted attachment
      profile.

### 4. Add attachment control and management

- [ ] Extend the daemon control command union to include `attach` and `detach`.
- [ ] Add CLI parser/types/usage support for
      `kato attach <session-selector> [--output <path>]`,
      `kato attachments`, and `kato detach <session-selector>`.
- [ ] Add daemon-side control handling for `attach` and `detach`.
- [ ] Expose attachment state through a listable surface (`kato attachments`
      and/or status output).
- [ ] Audit-log attach, re-attach, and detach actions clearly.

### 5. Resolve workspace profiles in the CLI

- [ ] Add "nearest ancestor `.kato/kato-config.yaml`" discovery for `attach`.
- [ ] Fail clearly when no local workspace config exists.
- [ ] Check whether the resolved workspace has a registry entry.
- [ ] Fail clearly with a `kato workspace register` action when it is not.
- [ ] Load the workspace config in the CLI.
- [ ] Treat the workspace config as partial and synthesize it against global
      output settings plus built-in defaults.
- [ ] Extract only the allowed output-shaping fields from that synthesized
      profile.
- [ ] Extract the supported workspace-scoped writer feature flags from that
      synthesized profile.
- [ ] Discard daemon-scoped and host-global fields when they appear in a
      workspace config.
- [ ] Resolve relative output defaults against that profile's `workspaceRoot`
      before sending them to the daemon.

### 6. Route recording/export behavior through session attachment

- [ ] Make pathless generated destinations use `workspaceAttachment` when
      present, otherwise the default workspace config.
- [ ] Make relative explicit in-chat paths resolve against the attached
      `workspaceRoot` when present, otherwise the default workspace root.
- [ ] Let `::record [<path>]` set or generate the session recording
      destination using the same resolution rules.
- [ ] Resolve writer render options from the current session attachment (or
      default workspace), not only from global daemon-start defaults.
- [ ] Make CLI pathless export use the same session-aware resolution.
- [ ] Keep directory-target behavior and final write-policy enforcement.

Writer render lookup changes:

- [ ] Update the `recording_pipeline.ts` write hot path so writer render options
      are resolved at write time, not baked only at daemon startup.
- [ ] Update `activateRecording`, `appendToActiveRecording`,
      `appendToDestination`, and the capture/export write helpers (or their
      current equivalents) to accept or look up session-aware writer options.
- [ ] Use this lookup chain for writer flags:
      `workspaceAttachment.writerFeatureFlags` -> default workspace/global
      config writer flags.
- [ ] Keep the selected output path stable while allowing subsequent writes to
      reflect refreshed writer flags.

### 7. Dynamic refresh for attached workspace configs

- [ ] Watch `workspace-registry.json` and reconcile the active config-file
      watcher set when registry entries are added or removed.
- [ ] Load watch targets from the workspace registry.
- [ ] Dedupe watchers by `sourceConfigPath` and update all affected session
      attachments on change.
- [ ] If reload fails, keep the last known good attachment profile and log a
      warning.
- [ ] Ensure live refresh only affects future generated destinations and future
      writes, not already-selected output paths.
- [ ] Do not install watchers for config paths outside the daemon's readable
      roots; require re-attach for those cases.

### 8. Remove `::init` and extend `::record`

- [ ] Remove `::init` from in-chat command parsing and docs.
- [ ] Allow `::record` to accept an optional path argument.
- [ ] Define clean, non-compat semantics for `::record` with and without a
      path.

### 9. Retain output-path capabilities

- [ ] Keep `defaultOutputDir` / `filenameTemplate`.
- [ ] Keep `output_paths.ts` and its shared helpers.
- [ ] Keep global config-template scaffolding for new workspace configs.
- [ ] Reuse the existing relative/directory path handling for attach-driven
      destinations.
- [ ] Reuse UTC+0 filename token rendering.

### 10. Tests

- [ ] Add CLI tests for `workspace init`, `workspace register`,
      `workspace list`, and `workspace unregister`.
- [ ] Add registry-store tests for create/update/remove and `registeredAt`.
- [ ] Add CLI tests showing `workspace register` is idempotent when the
      workspace config and allowed roots are unchanged.
- [ ] Add CLI/runtime tests showing restart-required `workspace register` warns
      when active recordings would fall outside the post-restart
      `allowedWriteRoots`.
- [ ] Add CLI/config tests showing `workspace unregister` prunes orphaned
      `allowedWriteRoots` entries while retaining roots still needed by other
      registered workspaces.
- [ ] Add parser/CLI tests for `attach`.
- [ ] Add parser/CLI tests for `attachments` and `detach`.
- [ ] Add control-plane tests for `attach` queueing and handling.
- [ ] Add control-plane tests for `detach` queueing and handling.
- [ ] Add control-plane tests showing re-attach audit logs include the previous
      `workspaceRoot`.
- [ ] Add session-state tests for persisting/reloading `workspaceAttachment`.
- [ ] Add runtime tests showing registry-file changes add or remove config-file
      watchers without requiring a restart when the daemon already has read
      access.
- [ ] Add runtime tests covering:
  - [ ] un-attached sessions using the default workspace
  - [ ] attached sessions using explicit workspace context
  - [ ] `::record <file>` sets the destination and starts recording
  - [ ] `::record <dir>/` uses that directory plus generated filename
  - [ ] pathless `::record` resumes the existing destination when present
  - [ ] pathless `::record` generates from workspace/global/default rules when
        no destination exists
  - [ ] workspace-scoped writer feature flags affect subsequent writes
  - [ ] writer feature flags fall back to global config when no attachment is
        present
  - [ ] config refresh updates subsequent writes while preserving the active
        recording path
  - [ ] attach on an unregistered workspace fails with a clear
        `workspace register` message
  - [ ] watcher targets come from the workspace registry, not allowed-root
        scanning
  - [ ] pathless export respecting the attachment
  - [ ] re-attach overwriting prior attachment
  - [ ] detach returning the session to default-workspace behavior
  - [ ] workspace unregister removes the registry entry but existing attached
        sessions keep running with their last persisted profile
  - [ ] `::init` is rejected after removal
  - [ ] writes outside the daemon config's `allowedWriteRoots` are still denied

### 11. Docs

- [ ] Update `README.md` to document the one-daemon model.
- [ ] Document `kato workspace init`, `kato workspace register`,
      `kato workspace list`, and `kato workspace unregister`.
- [ ] Document the workspace registry file and `registeredAt`.
- [ ] Document `kato attach` as the workspace-binding workflow.
- [ ] Document `kato attachments` and `kato detach`.
- [ ] Document `::record [<path>]`, `::capture [<path>]`, and
      `::export [<path>]` path behavior.
- [ ] Update
      `dev-docs/notes/dev.general-guidance.md` to remove `::init`, allow
      `::record [<path>]`, and keep the command/state-machine scenario table in
      sync with the new design.
- [ ] Document that attachment profiles auto-refresh from watched workspace
      configs and that explicit re-attach is the fallback for non-watchable
      configs or reload failures.
- [ ] Remove `::init` from the command set.
- [ ] Clarify that workspace configs are local output profiles, not separate
      daemon instances.

## Acceptance Criteria

- [ ] There is exactly one canonical daemon-owned session-state/twin store per
      host.
- [ ] Workspace-local `.kato/kato-config.yaml` can still control output
      defaults, but only via explicit session attach.
- [ ] A partial workspace config still produces a complete attachment profile by
      merging with global config values and then built-in defaults.
- [ ] Daemon-scoped or host-global keys present in a workspace config are
      ignored for attach.
- [ ] Supported writer render feature flags can be workspace-scoped via the
      attachment profile.
- [ ] Attaching a workspace does not widen daemon permissions live.
- [ ] `kato workspace register` owns daemon permission expansion and restart
      when needed.
- [ ] When a permission-changing restart would strand active recordings outside
      the post-restart `allowedWriteRoots`, Kato warns before that restart is
      triggered or advised.
- [ ] Registration is explicit via a persistent workspace-registry entry, not
      inferred only from `allowedWriteRoots`.
- [ ] `kato attach` fails if the current workspace is not already registered.
- [ ] `kato attach <session-selector>` binds a session to a workspace output
      context and can optionally set a session recording destination.
- [ ] `kato attachments` can show which sessions are explicitly attached versus
      using the default workspace.
- [ ] `kato detach <session-selector>` clears the attachment without deleting
      prior recordings.
- [ ] `kato workspace unregister` removes the registry entry without disrupting
      existing attached sessions or active recordings.
- [ ] `kato workspace unregister` prunes no-longer-needed persisted
      `allowedWriteRoots` entries without forcing a restart; live daemon
      permissions only fully narrow on the next restart.
- [ ] Sessions without an explicit attachment use the default workspace instead
      of failing or being ignored.
- [ ] Pathless and relative in-chat commands use the attached workspace when
      present, otherwise the default workspace.
- [ ] `::record [<path>]` is the in-chat command for selecting or resuming a
      recording destination.
- [ ] Directory-only output targets on `record`, `capture`, `export`, and
      attach `--output` generate a filename via the active template rules.
- [ ] Registered, watchable workspace config changes affect subsequent writes
      without requiring per-recording writer-flag snapshots.
- [ ] Pathless CLI export uses the same session-aware resolution.
- [ ] `::init` is removed.
- [ ] Final writes remain constrained by the daemon config's
      `allowedWriteRoots`.

## Risks And Mitigations

- Risk: the current runtime-config file mixes daemon-runtime fields with
  workspace-output fields.
  Mitigation: in the first pass, keep reusing the existing file format but load
  only a narrow attach-time subset; consider splitting schemas later.

- Risk: users may assume editing a workspace config updates already-attached
  sessions automatically.
  Mitigation: watch registered, readable workspace config files and refresh the
  persisted attachment profile on change; require re-attach only when a config
  is not watchable or a reload fails.

- Risk: old default-workspace recordings may surprise users after a later
  project attach.
  Mitigation: do not auto-delete them by default; switch only future behavior.

- Risk: users may still expect project-local auto-recording before attach.
  Mitigation: document clearly that workspace-local recording is explicit and
  attach-driven.
