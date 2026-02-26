---
id: utup12ei9wpp60uh2agzuhb
title: 2026 02 26 Workspace Settings
desc: ''
updated: 1772122525379
created: 1772118628434
---

## Goal

Add first-class workspace settings so recording/export behavior can vary by
project while keeping deterministic path resolution and security policy.

## User Story

As a user, I want each workspace to define local defaults for:

- ConversationEventKind capture settings
- default filename pattern
- default output directory
- default output format

and I want those defaults applied reliably without depending on daemon process
cwd.

## Why This Matters

- Current in-chat command path handling can resolve relative paths against the
  daemon process cwd, which is not always the originating workspace.
- Workspace-level defaults are becoming necessary as global config surface area
  grows.
- Explicit workspace identity is needed for both UX (predictable defaults) and
  policy (correct path evaluation context).

## Current Behavior Snapshot (2026-02-26)

- Runtime config is global-only at `~/.kato/kato-config.yaml`.
- In-chat commands normalize text (`@...`, markdown link, quotes) but do not
  resolve relative paths against a workspace context before policy evaluation.
- Write path policy canonicalizes with `resolve(trimmed)`, which means relative
  paths are resolved from daemon process cwd.
- Session metadata currently stores cursor/state/recording data but not a
  canonical workspace root.
- Provider source logs sometimes contain `cwd` context (for example Codex
  `session_meta` payload), but that context is not currently persisted into
  session metadata for path resolution.

## Recommendation on CWD Inference

We still need workspace context, but we should avoid late/path-policy-time cwd
inference.

Recommended model:

- primary: explicit workspace registration/discovery
- secondary: session-bound workspace identity persisted once
- fallback-only inference: provider metadata (`cwd`) or source-file heuristics
  when no explicit workspace is known

In other words: do not infer cwd every time a command runs. Resolve workspace
identity once, persist it, and use that for all relative path resolution.

## Scope

1. Workspace config loading and merge precedence (global + workspace).
2. Workspace discovery and explicit registration.
3. Workspace-aware path resolution for in-chat commands and workspace defaults.
4. CLI commands for workspace lifecycle.

## Non-Goals

- Full redesign of all runtime config fields.
- Auto-migration of historical session metadata to perfect workspace identity.
- Relaxing fail-closed path policy behavior.

## Decisions To Lock

### 1) Workspace Config Location

- Workspace config path: `<workspace>/.kato/kato-config.yaml`.
- Global config remains `~/.kato/kato-config.yaml`.

### 2) Workspace Registry In Global Config

Add a workspace registry section in global config with:

- explicit entries (registered roots)
- discovery patterns (glob roots for `.kato/kato-config.yaml`)
- optional caching metadata for discovered entries

Precedence for workspace identity resolution:

- explicitly registered workspace
- discovered workspace
- inferred fallback (provider/session hints)

### 3) Config Precedence

- CLI flag overrides (if present)
- workspace config
- global config
- built-in defaults

Missing keys should merge downward; unknown keys remain fail-closed.

### 4) Path Resolution Contract

- Relative in-chat command targets must resolve against session workspace root.
- Path policy should receive an already context-resolved path or receive
  explicit `baseDir` context.
- If workspace root is unknown, behavior should fail closed with clear audit and
  operational logging (unless command uses absolute path).

### 5) Security Boundary

- Workspace config can set output defaults and format defaults.
- Workspace config should not be able to widen global security policy beyond
  global `allowedWriteRoots` unless explicitly allowed by a separate global
  guard.

### 6) CLI Surface

- `kato workspace register [path]`:
  - create `<path>/.kato/kato-config.yaml` when missing
  - add/update global workspace registry entry
- `kato workspace list`
- `kato workspace unregister [path-or-id]`
- optional: `kato workspace discover --apply`

### 7) Workspace Verification and Revalidation

- Verify before persisting a new/updated workspace:
  - canonicalize root path
  - root exists and is a directory
  - `<workspace>/.kato/kato-config.yaml` exists or is creatable
  - parse + schema-validate workspace config
  - reject duplicate canonical roots and id collisions
- Re-verify existing workspaces on daemon startup and on config mtime/path
  change; optional bounded periodic checks for long-running daemons.
- Persist verification status rather than silently removing bad entries.
- Fail closed for invalid workspaces:
  - do not apply workspace defaults
  - do not resolve relative targets against that workspace
  - continue allowing absolute targets through normal path policy checks

## Proposed Schema Additions (Draft)

Global config additions:

- `workspaces`:
  - `registry`: array of workspace entries (`id`, `root`, `configPath`,
    `enabled`, `source`, `verificationStatus`, `lastVerifiedAt`,
    `lastVerificationError`, `lastKnownConfigMtimeMs`)
  - `discoveryGlobs`: array of glob patterns to scan for workspace configs
  - `autoDiscoverOnStart`: boolean

Workspace config additions:

- `recordingDefaults`:
  - `defaultOutputDir`
  - `filenamePattern`
  - `defaultFormat`
  - `includeEventKinds` (or equivalent event-kind filter section)

Session metadata additions:

- `workspaceRoot?`
- `workspaceId?`
- `workspaceResolutionSource?` (`registered`, `discovered`, `inferred`)
- `sourceSessionCwd?` (raw provider-provided cwd, when available)

## Implementation Plan

1. Contract layer:
   - extend shared config/session contracts and validators
   - keep strict unknown-key rejection for new sections too
2. Config loader:
   - load global config
   - resolve workspace identity from registry/discovery
   - load workspace config and merge
3. Workspace resolver:
   - deterministic resolver module with precedence rules
   - persist resolved workspace identity into session metadata
4. Path policy integration:
   - add workspace-aware relative path resolution before gate check
   - ensure audit logs include workspace context and resolution source
5. CLI commands:
   - register/list/unregister/discover
6. Docs and migration notes:
   - README and operator docs
7. Tests:
   - unit + integration coverage for resolution, merge, policy behavior

## Testing Plan

- Config tests:
  - parse/validate new workspace sections
  - reject unknown keys and invalid types
  - merge precedence correctness
- Resolver tests:
  - explicit registration beats discovery
  - discovery beats inference
  - nested workspace root tie-break rules
  - verification status transitions (`unverified` -> `valid|invalid`)
- Runtime tests:
  - in-chat relative path resolution uses workspace root
  - unknown workspace + relative target fails closed
  - absolute target behavior unchanged
  - invalid workspace blocks workspace-default application
- CLI tests:
  - register creates starter workspace config
  - list/unregister behavior
  - discover command behavior
  - register rejects invalid/duplicate workspaces before persist

## Acceptance Criteria

- Workspace config in `<workspace>/.kato/kato-config.yaml` is loaded and merged
  with global config.
- Relative in-chat paths are resolved by workspace context, not daemon cwd.
- Workspace registration/discovery is available and deterministic.
- Workspace entries are verified before persistence and re-verified over time.
- Invalid workspace entries are retained with explicit failure reasons.
- Workspace defaults can set capture/output behavior without weakening global
  write-root policy.
- Audit logs include enough context to explain how workspace and target paths
  were resolved.

## Risks and Mitigations

- Risk: ambiguous nested workspaces.
  Mitigation: explicit tie-break rule (longest matching root wins), log source.
- Risk: stale discovery cache.
  Mitigation: explicit refresh command and bounded auto-discovery cadence.
- Risk: provider `cwd` mismatch with filesystem reality.
  Mitigation: treat provider cwd as fallback hint only, not sole authority.
- Risk: widening write policy unintentionally via workspace config.
  Mitigation: keep global `allowedWriteRoots` as hard ceiling.

## Open Questions

- Should workspace config be allowed to narrow `allowedWriteRoots` (security
  tightening) while still forbidding widening?
- Do we want separate workspace-level defaults for CLI `kato export` vs
  in-chat commands, or one unified recording default section?
- For discovery globs, should we scan on daemon startup, CLI startup, or only
  on explicit command?
- How should we handle a session that appears to move workspaces over time?
- Should resolver prefer provider session `cwd` or source-file location when
  both exist but disagree?
