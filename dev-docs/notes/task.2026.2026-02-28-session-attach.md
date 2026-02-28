---
id: vcs43cmgkumrr4f0vkryyjo
title: 2026 02 28 Session Attach
desc: ''
updated: 1772293271000
created: 1772292128450
---

# Session Attach

## Goal

Restore a single host-global Kato daemon as the only owner of:

- provider ingestion
- in-memory session snapshots
- persisted session metadata
- persisted session twins

At the same time, preserve workspace-local output behavior by making workspace
selection an explicit per-session attachment step instead of a per-workspace
daemon choice.

The canonical daemon/runtime root should be `~/.kato/` by default (subject to
the existing env overrides), and it should remain the only place that stores
session state.

## Problem Statement

The per-workspace-daemon direction solves output customization, but it breaks a
more important invariant:

- there should be only one canonical twin/metadata set per host

If multiple daemons watch the same provider roots, they can all ingest the same
session and independently build:

- duplicate snapshots
- duplicate twins
- divergent session metadata

That is fundamentally wrong for durability, replay, and operational clarity.

The deeper issue is that an in-chat command cannot be the mechanism that
*establishes* workspace ownership. A daemon must already be watching that
session to even see the command, so "wait for `::init` to figure out the
workspace" is circular.

## Core Decision

Use a single-primary model:

- `kato start`, `restart`, `stop`, `status`, and `clean` target one primary
  daemon only.
- The primary daemon owns all provider ingestion and all persisted session
  state.
- Workspace `.kato/kato-config.yaml` files remain useful, but only as
  **workspace output profiles** loaded by the CLI during attach.
- A session may optionally carry an explicit attached workspace profile.
- If no explicit attachment exists, the session uses the **default workspace**,
  which is the primary daemon's own config context (`~/.kato` in the default
  layout).

This makes "unclaimed session" behavior predictable without losing the
non-workspace convenience path.

## UX Target

1. `kato start` starts only the primary daemon rooted at `~/.kato` (or the
   existing runtime-dir override).
2. The primary daemon watches provider session roots globally and keeps the one
   canonical session-state/twin store.
3. From inside a project workspace, the user runs
   `kato attach <session-selector> [--output <path>]`.
4. The CLI resolves the nearest ancestor `.kato/kato-config.yaml` and treats it
   as the workspace output profile. If no workspace config exists, it falls back
   to the default workspace (`~/.kato`).
5. `attach` binds that session to a workspace output context and prepares a
   primary recording destination for it (the replacement for the old workspace
   use of in-chat `::init`).
6. After attach, pathless and relative in-chat commands for that session use
   the attached workspace context.
7. If a session is never attached, in-chat commands still work, but they use the
   default workspace context.
8. There is no promise of "auto-record every conversation using workspace
   defaults" before an explicit attach. Workspace-local recording is opt-in.

## Command Model

### Primary CLI commands

- Keep daemon lifecycle commands as-is:
  - `kato init`
  - `kato start`
  - `kato restart`
  - `kato stop`
  - `kato status`
  - `kato clean`
- Add:
  - `kato attach <session-selector> [--output <path>]`
- Keep:
  - `kato export <session-selector> [--output <path>]`

`attach` is the new workspace-binding operation. It is intentionally separate
from `kato init`, which should remain a config-scaffolding command. Reusing
"init" for both daemon setup and session binding is too ambiguous.

### In-chat commands

Recommended steady-state in-chat commands:

- `::record`
- `::capture [<path>]`
- `::export [<path>]`
- `::stop`

`::init` should no longer be the primary workflow for workspace use.

Recommended transition behavior:

- keep `::init [<path>]` working for backward compatibility
- treat it only as "prepare or switch the primary recording destination inside
  the already-resolved workspace context"
- never let `::init` establish or change workspace ownership
- remove it from primary docs once `attach` exists

That preserves existing transcripts and habits without keeping the core design
dependent on an ambiguous command.

## Attach Semantics

`kato attach <session-selector> [--output <path>]` should:

1. Resolve the target session using the same selector rules as CLI export:
   exact id or a unique short selector, failing closed when ambiguous.
2. Resolve the attachment profile:
   - nearest ancestor `.kato/kato-config.yaml` from the current working
     directory
   - if none exists, use the default workspace profile (`~/.kato/kato-config.yaml`)
3. Load that profile in the CLI, not in the daemon.
4. Extract only the output-shaping subset needed for recording/export behavior.
5. Enqueue an `attach` control request to the primary daemon.
6. In the daemon, persist the session attachment and prepare the primary
   recording destination.

Recommended default behavior when `--output` is omitted:

- generate the destination using the attached profile's
  `defaultOutputDir + filenameTemplate`
- create the destination file if missing
- set it as the session's `primaryRecordingDestination`

This makes `attach` the CLI replacement for the "empty destination prep" role
that `::init` used to serve.

### `--output` behavior

Keep the same path semantics already implemented for export/init/capture:

- if `--output` is a file path, use that file
- if it resolves to a directory, generate the filename inside that directory
- if it is relative, resolve it against the attached profile's config root
- final writes still go through the primary daemon's `allowedWriteRoots`

## Session Metadata Model

Add an explicit optional attachment block to persisted session metadata.

Recommended shape:

```ts
interface SessionWorkspaceAttachment {
  attachedAt: string;
  sourceConfigPath?: string;
  configRoot: string;
  resolvedDefaultOutputDir: string;
  filenameTemplate: string;
}
```

Recommended semantics:

- If `workspaceAttachment` is absent, the session uses the default workspace
  (the primary daemon's runtime config).
- If `workspaceAttachment` is present, it overrides the default workspace for:
  - relative explicit path resolution
  - pathless generated destination resolution
- `primaryRecordingDestination` remains separate and keeps its current role.
- Re-attaching a session replaces the existing `workspaceAttachment`.
- Re-attach should be "last write wins" and should emit a clear audit log entry.

Important design choice:

- Persist a **snapshot** of the workspace output policy at attach time.
- Do not make the daemon re-read arbitrary workspace config files later.

Why:

- the CLI is already executing inside the target workspace and can safely read
  the local config
- the daemon should not need broad new read permissions across arbitrary
  worktrees
- this keeps the primary daemon's permission model tighter

If a workspace config changes later, the user should re-run `kato attach` to
refresh that session's attached profile.

## Default Workspace Behavior

Sessions without an explicit attachment should still be usable.

Recommended behavior:

- un-attached sessions implicitly use the primary daemon's own config context
- in the default layout, that means paths resolve relative to `~/.kato`'s
  output root rules
- in-chat `::record`, `::capture`, `::export`, and compatibility `::init`
  continue to work there

This is better than silently ignoring commands on un-attached sessions, and it
preserves the existing "just use Kato without a project workspace" mode.

## Handling Existing Default-Workspace Recordings During Attach

There is a real migration edge case:

- a session may first produce files in the default workspace
- later the user may explicitly attach it to a project workspace

Recommended default behavior:

- **do not delete or rewrite old default-workspace files automatically**
- simply switch future pathless/relative behavior to the attached workspace
- if `attach` creates a new primary destination, make that the new
  `primaryRecordingDestination`

This is the safest default. Silent cleanup is too risky.

Potential follow-on config knob if needed later:

- `cleanupDefaultWorkspaceRecordingsOnAttach?: boolean`

If this is ever added, it should default to `false`, and it should only affect
Kato-managed files that are confidently identified as default-workspace
artifacts. That policy is not needed for the first pass.

## What We Preserve From The Per-Workspace-Daemons Work

The per-workspace-daemons branch surfaced several useful pieces that should be
kept even though the multiple-daemon model itself should be abandoned.

Keep:

- `defaultOutputDir` in runtime/workspace config
- `filenameTemplate` in runtime/workspace config
- UTC+0 filename-template date tokens
- `snippetSlug` filename token
- generated-path helper centralization in `output_paths.ts`
- relative explicit path support
- directory-path handling for explicit output targets
- bare `::export`
- global config template seeding via `~/.kato/kato-config.template.yaml`

Reinterpret:

- workspace `.kato/kato-config.yaml` should still exist, but it becomes a
  workspace output profile read by the CLI during attach
- only the output-shaping fields from that config should affect an attached
  session

Discard / supersede:

- one daemon per workspace
- workspace-local session-state/twin stores
- using workspace-local `runtimeDir`, `statusPath`, or `controlPath` as
  independent daemon identities
- any expectation that `kato start` should launch a separate daemon per project

## Config-Scope Rules

When the CLI loads a workspace config for attach, it should only propagate the
fields that are safe and meaningful for per-session output behavior.

Recommended attach-time subset:

- `defaultOutputDir`
- `filenameTemplate`

Possible later additions, only if truly needed:

- `markdownFrontmatter`

Fields that should **not** be imported into per-session attachment state:

- `runtimeDir`
- `statusPath`
- `controlPath`
- `providerSessionRoots`
- `globalAutoGenerateSnapshots`
- `providerAutoGenerateSnapshots`
- logging config
- memory limits
- feature flags unrelated to capture/export formatting

This avoids smuggling daemon-runtime behavior through a workspace attachment.

## Security / Permission Rules

- The primary daemon remains the only process that writes recordings/exports.
- Session attachment must not widen daemon permissions.
- The daemon's global `allowedWriteRoots` remains the hard write boundary.
- A workspace attachment can influence path generation and relative path
  resolution, but not the allowed root set.
- If an attached workspace points at a path outside the primary daemon's
  `allowedWriteRoots`, the write must still be denied.

Operational implication:

- the primary config's `allowedWriteRoots` must already be broad enough to cover
  the workspaces where the user expects Kato to write

## Open Edge Cases To Handle Explicitly

- Attach before discovery:
  - if the session is not currently known, the daemon should force one
    provider-refresh pass before failing closed
- Attach races:
  - two `attach` requests for the same session should be serialized; last write
    wins
- Re-attach from a different workspace:
  - this should be allowed and should overwrite the previous attachment
- Workspace config changes after attach:
  - they do not apply retroactively; the user must re-run `attach`
- No local `.kato` in cwd:
  - `attach` falls back to the default workspace profile instead of failing
- Pathless CLI export:
  - when no explicit `--output` is provided, it should use the attached
    workspace if present, otherwise the default workspace

## Non-Goals

- Do not restore multiple independent daemon instances per workspace.
- Do not infer workspace ownership from provider session metadata or cwd alone.
- Do not promise automatic workspace-local recording for every new session.
- Do not broaden daemon filesystem permissions just to read random workspace
  configs at runtime.

## Scope

- [ ] Reassert single-primary daemon ownership of ingestion, snapshots, metadata,
      and twins.
- [ ] Add `kato attach <session-selector> [--output <path>]`.
- [ ] Add persisted per-session workspace attachment state.
- [ ] Route pathless and relative commands through attached workspace context
      when present.
- [ ] Use the default workspace (`~/.kato`) when no explicit session attachment
      exists.
- [ ] Keep `::init` only as a compatibility command; remove it from the primary
      recommended workflow.
- [ ] Preserve the output-path work from the per-workspace task
      (`defaultOutputDir`, `filenameTemplate`, relative/directory path support,
      UTC templating, config templates).
- [ ] Keep daemon writes constrained by the primary config's
      `allowedWriteRoots`.

## Implementation Plan

### 1. Re-center daemon lifecycle on the primary runtime

- [ ] Ensure daemon lifecycle commands (`start`, `restart`, `stop`, `status`,
      `clean`) always target the primary runtime config.
- [ ] Stop treating workspace-local runtime/status/control paths as separate
      daemon identities.
- [ ] Preserve env overrides (`KATO_RUNTIME_DIR`, `KATO_CONFIG_PATH`) as the
      way to relocate the primary runtime, not as a per-workspace mechanism.

### 2. Add session attachment state

- [ ] Extend the shared session-state contract with an optional
      `workspaceAttachment` block.
- [ ] Update the session metadata validator and clone logic.
- [ ] Decide whether to keep this as an additive optional field or bump the
      metadata schema version for stricter validation.
- [ ] Persist and reload attachment state in the session-state store.

### 3. Add attach to the control plane

- [ ] Extend the daemon control command union to include `attach`.
- [ ] Add CLI parser/types/usage support for
      `kato attach <session-selector> [--output <path>]`.
- [ ] Add daemon-side control handling for `attach`.
- [ ] Audit-log attach requests and re-attachments clearly.

### 4. Resolve workspace profiles in the CLI

- [ ] Add "nearest ancestor `.kato/kato-config.yaml`" discovery for `attach`.
- [ ] Fall back to the default workspace profile when no local config exists.
- [ ] Load the workspace config in the CLI.
- [ ] Extract only the allowed output-shaping fields from that config.
- [ ] Resolve relative output defaults against that profile's config root before
      sending them to the daemon.

### 5. Route recording/export behavior through session attachment

- [ ] Make pathless generated destinations use `workspaceAttachment` when
      present, otherwise the default workspace config.
- [ ] Make relative explicit in-chat paths resolve against the attached
      `configRoot` when present, otherwise the default workspace root.
- [ ] Make CLI pathless export use the same session-aware resolution.
- [ ] Keep directory-target behavior and final write-policy enforcement.

### 6. Narrow the role of `::init`

- [ ] Keep `::init` working as a compatibility command only.
- [ ] Remove any notion that `::init` binds a workspace.
- [ ] Update docs so `attach` replaces `::init` for workspace workflows.

### 7. Preserve the useful parts of the prior task

- [ ] Keep `defaultOutputDir` / `filenameTemplate`.
- [ ] Keep `output_paths.ts` and its shared helpers.
- [ ] Keep global config-template scaffolding for new workspace configs.
- [ ] Reuse the existing relative/directory path handling for attach-driven
      destinations.
- [ ] Reuse UTC+0 filename token rendering.

### 8. Tests

- [ ] Add parser/CLI tests for `attach`.
- [ ] Add control-plane tests for `attach` queueing and handling.
- [ ] Add session-state tests for persisting/reloading `workspaceAttachment`.
- [ ] Add runtime tests covering:
  - [ ] un-attached sessions using the default workspace
  - [ ] attached sessions using explicit workspace context
  - [ ] pathless export respecting the attachment
  - [ ] re-attach overwriting prior attachment
  - [ ] compatibility `::init` not changing workspace ownership
  - [ ] writes outside global `allowedWriteRoots` still being denied

### 9. Docs

- [ ] Update `README.md` to document the single-primary model.
- [ ] Document `kato attach` as the workspace-binding workflow.
- [ ] Demote `::init` from the recommended command set.
- [ ] Clarify that workspace configs are local output profiles, not separate
      daemon instances.

## Acceptance Criteria

- [ ] There is exactly one canonical daemon-owned session-state/twin store per
      host.
- [ ] Workspace-local `.kato/kato-config.yaml` can still control output
      defaults, but only via explicit session attach.
- [ ] `kato attach <session-selector>` binds a session to a workspace output
      context and prepares a primary recording destination.
- [ ] Sessions without an explicit attachment use the default workspace instead
      of failing or being ignored.
- [ ] Pathless and relative in-chat commands use the attached workspace when
      present, otherwise the default workspace.
- [ ] Pathless CLI export uses the same session-aware resolution.
- [ ] `::init` no longer determines workspace ownership.
- [ ] Final writes remain constrained by the primary daemon's
      `allowedWriteRoots`.

## Risks And Mitigations

- Risk: the current runtime-config file mixes daemon-runtime fields with
  workspace-output fields.
  Mitigation: in the first pass, keep reusing the existing file format but load
  only a narrow attach-time subset; consider splitting schemas later.

- Risk: users may assume editing a workspace config updates already-attached
  sessions automatically.
  Mitigation: attachment stores a snapshot of output policy; require re-attach
  to refresh.

- Risk: old default-workspace recordings may surprise users after a later
  project attach.
  Mitigation: do not auto-delete them by default; switch only future behavior.

- Risk: users may still expect project-local auto-recording before attach.
  Mitigation: document clearly that workspace-local recording is explicit and
  attach-driven.
