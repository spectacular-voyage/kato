---
id: t3lfa9r314byjwjoga3d5qe
title: 2026 03 01 Workspace Aliases
desc: ''
updated: 1772415248669
created: 1772395927887
---

Supersedes [task.2026.2026-02-28-session-attach.md](/home/djradon/hub/spectacular-voyage/kato/documentation/notes/task.2026.2026-02-28-session-attach.md).
# Workspace Aliases: Live Registration Revision

## Summary

Revise the workspace-alias design so that a running daemon can pick up **new registrations, unregistrations, and workspace-config content changes** without a restart, while keeping **workspace-root / config-path / alias mutations on existing entries** restart-bound.

This gives the desired UX:

- `workspace register` is usable immediately in the common case.
- `workspace unregister` removes the alias immediately for new commands.
- Editing `<workspaceRoot>/.kato/kato-workspace-config.yaml` affects future commands without restarting.
- Existing in-progress recording cycles do not change mid-stream.
- If a newly registered workspace root is not already covered by the daemon’s current `allowedWriteRoots`, registration still succeeds, but the user gets a clear warning that writes will require `kato restart`.

This revision does **not** require filesystem watchers. A lazy reload on command boundaries is simpler and sufficient.

## Core Behavior Changes

### Live pickup scope

Live, without restart:

- `workspace register` for a **new** workspace
- `workspace unregister`
- Workspace-local config file **content** changes

Still restart-bound:

- Changing `workspaceRoot` on an existing registry entry
- Changing `configPath` on an existing registry entry
- Changing `alias` on an existing registry entry
- Any change that requires expanding or shrinking the daemon’s active `allowedWriteRoots` set
- Existing active recording-cycle bindings and their writer behavior

### What “picked up live” means

For new alias-scoped commands, the daemon uses the latest available workspace catalog and workspace config snapshot at command time.

It does **not** mean:

- retroactively changing active recording cycles
- rewriting existing current output bindings
- hot-swapping write-policy roots already baked into the running daemon

## Config Files And Discovery

### Global runtime config

Keep:

- `~/.kato/kato-config.yaml`

It remains the daemon bootstrap config.

### Workspace-local config

Canonical new path:

- `<workspaceRoot>/.kato/kato-workspace-config.yaml`

Rules:

- `workspace init` always writes the new filename.
- `workspace register` expects the canonical workspace-local filename.
- Docs should only teach the new workspace-local filename.

## Live Workspace Catalog Design

### Registry store

Persist the registry immediately on every `workspace register` / `workspace unregister`.

Recommended persistent shape:

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

### In-memory catalog

The daemon keeps an in-memory `WorkspaceCatalog` cache, but refreshes it lazily.

Recommended runtime shape:

```ts
interface WorkspaceCatalogSnapshot {
  loadedAt: string;
  sourceMtimeMs?: number;
  byAlias: Map<string, RegisteredWorkspace>;
  byWorkspaceId: Map<string, RegisteredWorkspace>;
}
```

### Refresh policy

On every alias-scoped in-chat command:

- Check the workspace-registry file mtime.
- If unchanged, keep the current catalog snapshot.
- If changed, reload the registry and rebuild the alias maps.

This is the live pickup mechanism for register/unregister.

No long-running `watchFs` loop is required for the registry.

## Registration And Unregistration Semantics

### `workspace register`

For a **new** workspace entry:

- Persist the registry entry immediately.
- The next alias-scoped command sees the new alias after the catalog mtime check.
- No daemon restart is required to resolve the alias.

However:

- If the new `workspaceRoot` is already inside one of the daemon’s current `allowedWriteRoots`, writes can proceed immediately.
- If the new `workspaceRoot` is **not** inside current `allowedWriteRoots`, registration succeeds but returns a warning:
  - workspace registered
  - alias is visible immediately
  - writes targeting paths under that workspace may still be denied until `kato restart`

This preserves the current write-policy model while making registration itself live.

### Re-registering an existing workspace

If `workspace register` targets an already-known `workspaceId` and changes any of these:

- `alias`
- `workspaceRoot`
- `configPath`

Then:

- Persist the change immediately in the registry
- Return a clear message that the change is saved but requires `kato restart`
- Keep the running daemon’s current catalog entry unchanged until restart

This avoids partial live mutation of identity and path semantics.

### `workspace unregister`

- Persist removal immediately
- The next alias-scoped command sees that the alias is gone
- New alias-targeted commands fail immediately

Existing session state is preserved:

- Existing current output bindings for that `workspaceId` remain valid
- Existing active recording cycles continue running
- Those existing bindings/cycles can still append using their stored resolved path and stored profile snapshot
- Only new alias-based lookup is blocked because the alias no longer exists in the live catalog

This matches the chosen “preserve existing” behavior.

## Live Workspace Config Content Reload

### Scope

A change to the contents of:

- `<workspaceRoot>/.kato/kato-workspace-config.yaml`

should be picked up without restart.

This includes fields such as:

- `defaultOutputDir`
- `filenameTemplate`
- writer feature flags / render settings carried in the workspace-local profile

### Mechanism

Use lazy reload on command boundaries, not a watcher.

Recommended design:

```ts
interface WorkspaceProfileCacheEntry {
  workspaceId: string;
  configPath: string;
  sourceMtimeMs?: number;
  loadedAt: string;
  profile: ResolvedWorkspaceProfile;
}
```

On commands that need a workspace profile:

- Check the config file mtime
- Reload only if the file changed
- Recompute the resolved workspace profile

### Application rule

Workspace-config content changes apply to:

- `::init-<alias>`
- `::capture-<alias>`
- `::export-<alias>`
- `::record-<alias>` when starting a new recording cycle
- `::record-<alias>` when retargeting to a different destination

Workspace-config content changes do **not** apply to:

- an already-active recording cycle that keeps writing to its current output file

In-progress cycles continue using their stored snapshot until they stop.

## Command Semantics

### `::init-<alias> [<path>]`

- Creates or retargets the current output binding
- Creates the file if missing
- Leaves `desiredState = off`
- Uses the latest live workspace profile at command time

### `::record-<alias> [<path>]`

- If starting a new cycle, uses the latest live workspace profile
- If retargeting to a different destination, ends the old cycle and starts a new one using the latest live profile
- If resuming the same destination while a cycle is already active, keep the existing cycle snapshot unchanged
- If resuming after `stop`, start a new recording cycle using the latest live profile, while keeping the current output binding unless a new path is specified

### `::capture-<alias> [<path>]`

- Append-only
- Never truncates
- Uses the latest live workspace profile when resolving a generated or directory target
- Does not start or stop live recording

### `::export-<alias> [<path>]`

- Append-only
- Never truncates
- Uses the latest live workspace profile when resolving a generated or directory target
- Does not modify the current output binding

### `::stop-<alias>` / `::stop`

No change:

- stop active recording cycles
- preserve current output bindings

## Runtime State Model

Keep the earlier shift to “one current output binding per `sessionId + workspaceId`” and “at most one active recording cycle per `sessionId + workspaceId`”.

Recommended durable shape:

```ts
interface SessionWorkspaceOutputState {
  workspaceId: string;
  workspaceAliasSnapshot?: string;
  desiredState: "on" | "off";
  currentDestination: OutputDestinationBinding;
  currentResolvedPath: string;
  sourceConfigPath?: string;
  workspaceRootSnapshot: string;
  resolvedDefaultOutputDir: string;
  filenameTemplate: string;
  writerFeatureFlags: {
    writerIncludeCommentary: boolean;
    writerIncludeThinking: boolean;
    writerIncludeToolCalls: boolean;
    writerItalicizeUserMessages: boolean;
  };
  activeRecordingCycleId?: string;
  recordingCycles: RecordingCycleState[];
}
```

```ts
interface RecordingCycleState {
  recordingCycleId: string;
  startedAt: string;
  stoppedAt?: string;
  startedCursor: number;
  stoppedCursor?: number;
}
```

Important rule:

- `workspaceRootSnapshot`, `filenameTemplate`, and writer flags stored on the active state remain authoritative for an already-running cycle
- A fresh command may refresh the profile snapshot only when establishing a new cycle or new target

## Write Policy And `allowedWriteRoots`

### Startup model remains

The running daemon’s `allowedWriteRoots` still comes from its startup-loaded runtime policy.

Do not hot-mutate the active path-policy gate in this task.

### Consequence for live registration

A newly registered workspace may fall into one of two states:

1. Already covered by current `allowedWriteRoots`
   - usable immediately
2. Not covered
   - alias resolves immediately
   - write commands may still be denied
   - `workspace register` should emit a warning suggesting `kato restart`

### Warning criteria

On `workspace register`, compare the new `workspaceRoot` against the daemon’s current `allowedWriteRoots` snapshot.

If not covered, print a clear warning:

- the workspace was registered successfully
- the running daemon has not yet expanded its write roots
- restart is recommended before writing to that workspace

Per-workspace narrowing of write roots stays deferred.

## Frontmatter Policy

No change to the prior direction:

- Frontmatter remains optional
- It never gates writes
- All in-chat commands are append-only

When frontmatter is enabled, use plural provenance fields:

- `sessionIds`
- `workspaceIds`
- `recordingCycleIds`

These remain accretive and deduped.

## Public API / Type Changes

### Parser contract

Keep the earlier explicit form:

```ts
interface InChatControlCommand {
  verb: "init" | "record" | "capture" | "export" | "stop";
  alias?: string;
  argument?: string;
  line: number;
  raw: string;
}
```

### New daemon-side components

Add explicit interfaces for live-refresh infrastructure:

```ts
interface WorkspaceRegistryStoreLike {
  load(): Promise<RegisteredWorkspace[]>;
  save(entries: RegisteredWorkspace[]): Promise<void>;
  statMtimeMs?(): Promise<number | undefined>;
}
```

```ts
interface WorkspaceCatalogLike {
  getByAlias(alias: string): Promise<RegisteredWorkspace | undefined>;
  getByWorkspaceId(workspaceId: string): Promise<RegisteredWorkspace | undefined>;
  list(): Promise<RegisteredWorkspace[]>;
  refreshIfChanged(): Promise<void>;
}
```

```ts
interface WorkspaceProfileResolverLike {
  resolveForCommand(workspace: RegisteredWorkspace): Promise<ResolvedWorkspaceProfile>;
}
```

These make the live-refresh boundary explicit and testable.

## Implementation Sequence

1. Introduce the new workspace-local config filename and legacy fallback lookup.
2. Add the persistent workspace registry keyed by `workspaceId`.
3. Add `WorkspaceCatalog` with lazy `refreshIfChanged()` based on registry file mtime.
4. Route alias lookup through the live-refreshing catalog on every alias-scoped command.
5. Implement `workspace register` live-add behavior for new entries.
6. Implement `workspace unregister` live-remove behavior while preserving existing session bindings/cycles.
7. Make re-registering an existing entry with alias/root/configPath changes persist immediately but return “restart required,” without changing the live catalog.
8. Add `WorkspaceProfileResolver` with lazy config-file mtime reload.
9. Apply refreshed workspace config only when starting a new cycle, retargeting, or running one-off `init`/`capture`/`export`.
10. Keep active cycles pinned to their stored snapshot until stopped.
11. Keep `allowedWriteRoots` startup-bound; add registration-time coverage warnings.
12. Preserve the append-only, frontmatter-optional semantics from the prior plan.
13. Update docs to explain the split:
    - live register/unregister/config-content
    - restart-bound alias/root/configPath edits and write-root expansion

## Test Cases

### Live registration

- Registering a brand-new workspace makes `::record-<alias>` resolvable without restart.
- If the new workspace root is already inside current `allowedWriteRoots`, `::record-<alias>` can write immediately.
- If the new workspace root is not covered, registration succeeds and emits a restart warning.
- In that uncovered case, alias lookup succeeds but write commands are denied by path policy until restart.

### Live unregistration

- Unregistering a workspace removes its alias immediately for new commands.
- Existing active cycles for that `workspaceId` continue appending successfully.
- Existing paused/current output bindings for that `workspaceId` remain in session state.
- New `::record-<alias>` / `::capture-<alias>` / `::export-<alias>` fail because the alias is gone.

### Restart-bound updates on existing entries

- Re-registering an existing workspace with a changed alias persists the update but the old alias remains live until restart.
- Re-registering an existing workspace with a changed `workspaceRoot` persists the update but path resolution stays on the old root until restart.
- Re-registering an existing workspace with a changed `configPath` persists the update but the old config path remains live until restart.

### Live workspace-config changes

- Editing `defaultOutputDir` in a workspace-local config changes the next generated destination for `::init-<alias>`, `::capture-<alias>`, `::export-<alias>`, or a newly started `::record-<alias>` cycle without restart.
- Editing `filenameTemplate` changes the next generated filename without restart.
- Editing writer flags changes the next new recording cycle’s render behavior without restart.
- An already-active recording cycle keeps using its existing stored writer flags and destination behavior until stopped.

### Command behavior

- `::record-<alias>` starting a fresh cycle after a config edit uses the latest config snapshot.
- `::record-<alias>` continuing an already-active cycle does not change behavior mid-stream.
- `::init-<alias>` after a config edit uses the latest config snapshot.
- `::capture-<alias>` and `::export-<alias>` remain append-only and never truncate.

## Explicit Assumptions And Defaults

- No `watchFs` watcher is added for the workspace registry or workspace-local config files.
- Live pickup is implemented by lazy mtime checks on command boundaries.
- New registrations and unregistrations are live.
- Workspace-config content changes are live.
- Alias changes, root changes, and config-path changes on existing entries remain restart-bound.
- `allowedWriteRoots` remains startup-bound in this task.
- If registration succeeds but the new root is outside current write roots, the CLI warns and recommends restart.
- Existing session bindings/cycles survive unregistration.
- In-progress recording cycles keep their stored profile snapshot until stopped.
