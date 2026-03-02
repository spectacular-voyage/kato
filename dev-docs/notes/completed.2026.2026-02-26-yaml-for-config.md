---
id: mh7o8byz9ckv7csapd0zyiu
title: 2026 02 26 Yaml for Config
desc: ''
updated: 1772122364745
created: 1772120654851
---

## Goal

Use YAML runtime config (`kato-config.yaml`) so users can:

- comment out optional sections safely
- add in-file explanatory comments
- keep config readable as options grow (global + workspace-level settings)

## User Story

As a user, I want to comment out parts of my config and keep explanatory notes
in the config itself.

## Why This Matters

- Current runtime config path is moving to `~/.kato/kato-config.yaml`, which supports comments.
- Upcoming workspace settings (`task.2026.2026-02-26-workspace-settings.md`)
  will increase config surface area and benefit from human-readable comments.
- YAML gives better operator ergonomics without changing runtime behavior.

## Scope (This Task)

1. Add YAML runtime-config read/write support.
2. Backward compatibility is not desired: remove all support for JSON config.
3. YAML for  newly initialized configs.
4. Update CLI/docs/tests to reflect the new canonical path/format.

## Non-Goals

- Redesign runtime config schema fields in this task.
- Implement workspace config loading in this task.
- Preserve comments across in-place rewrite operations (no such rewrite command
  exists yet).

## Decisions To Lock

### 1) Canonical File + Resolution Order

- Canonical path for new installs: `~/.kato/kato-config.yaml`.
- `KATO_CONFIG_PATH` keeps top priority when explicitly set.
- When `KATO_CONFIG_PATH` is not set, try `~/.kato/kato-config.yaml`
- default-create target: `~/.kato/kato-config.yaml`

### 2) Schema/Validation Contract

- Keep `schemaVersion: 1` and current field contract (`RuntimeConfig`).
- Keep strict fail-closed validation behavior:
  - unknown `featureFlags` keys rejected
  - unknown `logging` keys rejected
  - invalid types rejected
- YAML format support does not relax validation rules.

### 3) Serialization Rules

- Use `@std/yaml` for YAML parse/stringify.
- Accept only `.yaml`
- `kato init` writes YAML for newly created configs.

## Implementation Plan

1. Add YAML dependency and loader/writer support.

- Add `@std/yaml` to `deno.json` imports and lockfile.
- Extend config file store parsing/writing for YAML only (`.yaml`).
- Keep parsing boundary centralized in
  `apps/daemon/src/config/runtime_config.ts` (or a small helper under
  `apps/daemon/src/config/`).

2. Update runtime config path resolution.

- Replace single `CONFIG_FILENAME = "config.json"` with
  `CONFIG_FILENAME = "kato-config.yaml"`.
- Update `resolveDefaultConfigPath(...)` to return the chosen existing path (or
  canonical YAML default when none exist).
- Ensure CLI and daemon subprocess both use the same resolution rules.

1. Keep validation strict and unchanged.

- Reuse `parseRuntimeConfig(...)` after parsing YAML into JS values.
- Keep current strict key allowlist behavior and backfills.
- Confirm env override behavior still applies unchanged
  (`KATO_LOGGING_*`, `KATO_DAEMON_MAX_MEMORY_MB`).

4. Update CLI/help/startup UX.

- Update command usage/help text to reference `~/.kato/kato-config.yaml`.
- Ensure `kato init` / auto-init status lines print the resolved YAML path.
- Keep fail-closed startup errors explicit and path-specific.

5. Update docs and operator guidance.

- `README.md`: runtime files + config example as YAML.
- `dev-docs/notes/dev.codebase-overview.md`: topology/config path updates.
- `dev-docs/notes/dev.testing.md`: config edit instructions updated for YAML.

6. Follow-up (optional, separate task if needed).

- Add `kato config validate` command (already noted in `dev.todo`).

## Testing Plan

- Unit/config tests:
  - load valid YAML config with comments
  - reject malformed YAML
  - reject unknown keys in YAML objects (same fail-closed behavior)
  - reject non-`.yaml` runtime config paths
- CLI tests:
  - `init` creates YAML config path by default
  - `start`/`restart` auto-init messaging reports YAML path
- Integration/regression:
  - daemon starts with YAML config and normal runtime loop behavior
  
## Acceptance Criteria

- Users can add comments in runtime config without breaking startup.
- Users can comment out optional config blocks and retain valid behavior.
- `kato init` creates `~/.kato/kato-config.yaml` for new setups.
- CLI/docs/tests reflect YAML as "the" format.

## Risks And Mitigations

- YAML parser flexibility could hide bad types.
  Mitigation: keep strict runtime validators unchanged.


## Open Questions

- Should we explicitly disallow YAML advanced features (anchors/aliases) for
  simplicity?
- Do we want `kato config validate` in the same milestone or keep it separate?
