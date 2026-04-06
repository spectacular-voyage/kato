---
id: 2twwyf05s2u40rr4zc302dp
title: 2026 03 03 Fix Default User
desc: ''
updated: 1772556756499
created: 1772555024000
---

## Goal

Support per-user participant settings for frontmatter `participants`, without
encoding personal usernames in shared workspace config and without exposing
environment/OS usernames.

## Summary

We are removing `defaultParticipantUsername` entirely and introducing an
explicit user-local participant config at `~/.kato/kato-user-config.yaml`.
Username inclusion becomes explicit-only:

- include `user.<username>` only when configured in user config
- never infer from `USER`, `USERNAME`, or home-dir basename
- default to exclusion via `excludeMeFromParticipantList: true`

This task also includes new `kato user ...` commands for mapping CRUD.

## Discussion

### Privacy-first resolution policy

When `addParticipantUsernameToFrontmatter` is `true`:

1. if `participants.excludeMeFromParticipantList` is `true`, omit user
   participant
2. if workspace has mapping in `participants.workspaceUsernames[workspaceId]`,
   include that username
3. else if `participants.defaultUsername` is non-empty, include that username
4. else omit user participant

When `addParticipantUsernameToFrontmatter` is `false`, omit user participant.

No env/OS fallback is allowed.

### User config location authority

User config path is always `~/.kato/kato-user-config.yaml` (resolved from home
directory), not `katoDir`-relative and not workspace-relative.

### Username validation policy

Usernames preserve case and punctuation except control chars.

- trim leading/trailing whitespace for validation/storage
- reject empty string after trim
- reject ASCII control chars (`U+0000..U+001F`, `U+007F`)
- max length: 128 Unicode code points

### Command behavior policy

- `kato user map set/delete <workspace-alias-or-id>` must resolve to a
  registered workspace and fail hard otherwise.
- Unknown alias/ID is a command error: non-zero exit and actionable stderr.
- `workspaceUsernames` keys remain `workspaceId` for stability.
- Unregistering a workspace does not auto-prune mappings.
- A follow-up `kato user map prune` command can be added later.
- `kato user init` is idempotent: create on first run, "already exists" on
  subsequent runs.

### Command/state scenario table

| Scenario                                            | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes                                                                          |
| --------------------------------------------------- | ------------------ | ---------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `kato init` with no configs                         | Yes                | N/A                    | Yes            | Creates `kato-daemon-config.yaml`, `default-kato-workspace-config.yaml`, and `kato-user-config.yaml`. |
| `kato start` auto-init path when configs missing    | Yes                | N/A                    | Yes            | Auto-init also creates `kato-user-config.yaml`.                                                       |
| `kato user init`                                    | Yes                | N/A                    | Yes            | Explicitly creates `kato-user-config.yaml` if missing; otherwise reports already exists.              |
| `kato user map set <alias> <username>`              | Yes                | N/A                    | Yes            | Alias must resolve to registered workspaceId or command fails hard.                                   |
| `kato user map delete <alias-or-id>` unknown target | Yes                | N/A                    | Yes            | Fail hard; no mutation.                                                                               |
| `kato user map list`                                | Yes                | N/A                    | Yes            | Default text output for humans.                                                                       |
| `kato user map list --json`                         | Yes                | N/A                    | Yes            | Stable machine-readable schema (see Contract Changes).                                                |
| recording/export with no explicit username config   | Yes                | Yes                    | Yes            | User participant omitted; no env/OS fallback.                                                         |

## Contract Changes

### Config schema changes

- Remove `defaultParticipantUsername` from:
  - `shared/src/contracts/config.ts` (`MarkdownFrontmatterConfig`)
  - runtime config parser/defaults/scaffold
  - workspace config parser/defaults/scaffold/template
  - docs and tests referencing that key

- Add user config schema (`~/.kato/kato-user-config.yaml`):

```yaml
schemaVersion: 1
participants:
  defaultUsername: ""
  workspaceUsernames: {}
  excludeMeFromParticipantList: true
```

### CLI contract changes

Add `kato user` command surface:

- `kato user init`
- `kato user map set <workspace-alias-or-id> <username>`
- `kato user map list [--json]`
- `kato user map delete <workspace-alias-or-id>`
- `kato user default set <username>`
- `kato user default clear`
- `kato user exclude-me <true|false>`

Command behavior:

- commands lazily create `~/.kato/kato-user-config.yaml` when missing
- unknown alias/id is an error (non-zero exit)

### `kato user map list --json` output schema

```json
{
  "schemaVersion": 1,
  "mappings": [
    {
      "workspaceId": "cd940f00-5558-40dc-bead-46f904ab937b",
      "workspaceAlias": "k",
      "username": "Dj Radon"
    }
  ]
}
```

Ordering rule: `mappings` sorted by `workspaceAlias`, then `workspaceId`.

## Testing

- [x] `tests/user-config_test.ts`:
  - default creation/scaffold
  - valid parse
  - unknown key/type rejection
  - username validation (trim, empty rejection, control-char rejection, length
    cap)
- [x] `tests/daemon-cli_test.ts`:
  - `init` creates user config
  - `start/restart` auto-init also creates user config
  - repeated init reports already exists
- [x] `kato user` command tests:
  - map set/list/delete success
  - map set/delete unknown alias/id fail hard
  - list `--json` schema and ordering
  - default set/clear behavior
  - exclude-me toggle behavior
- [x] resolver tests:
  - precedence order (exclude -> workspace map -> default -> omit)
  - no participant when `addParticipantUsernameToFrontmatter=false`
  - no env/OS fallback paths
- [x] integration coverage in recording/export tests:
  - workspace output uses workspaceId mapping
  - non-workspace export uses `defaultUsername`
  - participant omitted when no explicit username exists

## Non-Goals

- Renaming `kato-daemon-config.yaml` again.
- Adding OS-specific file-permission hardening for user config.
- Auto-pruning mappings on workspace unregister.
- Introducing a full config migration framework.

## Implementation Plan

### A) Remove legacy `defaultParticipantUsername` end-to-end

- [x] Remove field from shared contract and all runtime/workspace config
      parser/default/scaffold paths.
- [x] Remove resolver usage and all env/home fallback logic in `main.ts` and
      `daemon_runtime.ts`.
- [x] Update docs/tests/fixtures that still reference the legacy key.

### B) Add user config module

- [x] Add `apps/daemon/src/config/user_config.ts` with:
  - `resolveDefaultUserConfigPath()` targeting `~/.kato/kato-user-config.yaml`
  - scaffold creation
  - parser/validator (fail-closed on invalid shape/unknown keys)
  - `UserConfigFileStore` with `load()` and `ensureInitialized()`
- [x] Export new APIs via `apps/daemon/src/config/mod.ts` and
      `apps/daemon/src/mod.ts`.

### C) Init/auto-init integration

- [x] Update `ensureGlobalConfigInitialized` to also ensure user config.
- [x] Update `kato init` output and telemetry for user-config create/exist
      status.
- [x] Ensure `start/restart` auto-init path also creates user config.
- [x] Update CLI usage/help text mentioning created files and `kato user`.

### D) Unify participant username resolver

- [x] Introduce one shared resolver utility (single source of truth) used by
      `main.ts` and `daemon_runtime.ts`.
- [x] Inputs:
  - frontmatter flag (`addParticipantUsernameToFrontmatter`)
  - workspaceId (optional)
  - user config
- [x] Ensure resolver implements explicit-only policy and validation rules.

### E) Implement `kato user` command group

- [x] Add parser/router/usage entries for all `kato user` subcommands.
- [x] Implement alias-or-id resolution through workspace registry with hard
      failure on unknown target.
- [x] Implement list text mode and `--json` mode with stable ordering/schema.
- [x] Ensure commands lazily initialize user config when missing.

### F) Documentation + merge checklist

- [x] Update README with new user config schema and privacy behavior.
- [x] Update sample docs such as `documentation/notes/kato-workspace-config.yaml` to
      remove legacy key.
- [ ] Update [[dev.codebase-overview]] and [[dev.decision-log]] before merge.
