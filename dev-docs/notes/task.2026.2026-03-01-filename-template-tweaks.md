---
id: 4t97owqubbhk7poems1t1va
title: 2026 03 01 Filename Template Tweaks
desc: ''
updated: 1772439219106
created: 1772422088094
---

# Filename Template Tweaks

## Goal

- Replace UTC-only filename timestamp token behavior with clearer, timezone-aware tokens.
- Add an explicit workspace config key for filename timestamp timezone.
- Document supported template tokens and timezone behavior in `README.md`.

## Summary

Current filename rendering only supports `{timestampUtc}` and always uses UTC.
This task adds three explicit tokens:

- `{timestampISO8601}`
- `{timestampHumane}` (format `YYYY-MM-DD_HHmm`, for example `2026-03-01_1234`)
- `{snippetSlug}` (slugified session snippet)

This task also adds `filenameTemplateTimezone` to workspace config, with
supported values:

- `"local"` (system timezone of the daemon process)
- an IANA timezone identifier (for example `"America/Los_Angeles"`)
- `"UTC"`

## Discussion

### Current behavior (baseline)

- `apps/daemon/src/orchestrator/daemon_runtime.ts` renders only `{timestampUtc}`.
- `apps/daemon/src/workspace/registry.ts` scaffolds
  `filenameTemplate: "{provider}-{sessionShortId}-{timestampUtc}.md"`.
- Workspace config does not currently expose a filename timezone key.

### Proposed token behavior

- `{timestampISO8601}`:
  - Timestamp in configured timezone using ISO8601 offset form.
  - Example source value: `2026-03-01T12:34:56-08:00`.
  - Existing filename normalization remains in place after token replacement.
- `{timestampHumane}`:
  - Timestamp in configured timezone using `YYYY-MM-DD_HHmm`.
  - Example: `2026-03-01_1234`.
  - Intended for shorter, easier-to-read filenames.
- `{snippetSlug}`:
  - Slugified snippet derived from session content.
  - Should be filesystem-safe and lowercase with `-` separators.
  - Falls back to a stable placeholder when no snippet text is available.

### Timezone behavior

- New config key: `filenameTemplateTimezone`.
- Allowed values:
  - `"local"`
  - `"UTC"`
  - IANA timezone id (validated at config load/resolve time).
- Default:
  - `"local"` when key is absent.
- Invalid timezone values should fail config loading with a clear error.

### Compatibility and migration

- Default scaffold template should move to
  `"{timestampHumane}-{snippetSlug}-{provider}.md"`
- Remove `{timestampUtc}` everywhere, no backward compatibility needed
- README needs updates.

### Library/runtime choice

- No third-party date/time dependency is required.
- Prefer Deno runtime `Intl` APIs for timezone handling/validation:
  - `Intl.DateTimeFormat(..., { timeZone })` validation via try/catch.
  - `Intl.supportedValuesOf("timeZone")` when available for stricter checks.

## Contract Changes

- Workspace config schema (`kato-workspace-config.yaml` and default template):
  - add optional `filenameTemplateTimezone: string`
- Workspace profile resolution contracts:
  - `WorkspaceConfigOverrides` gains `filenameTemplateTimezone?: string`
  - `ResolvedWorkspaceProfile` gains `filenameTemplateTimezone: string`
- Filename renderer token contract:
  - add `{timestampISO8601}`
  - add `{timestampHumane}`
  - add `{snippetSlug}`
- Documentation contract:
  - README includes a token table with examples and timezone semantics
  - README config examples include `filenameTemplateTimezone`

## Testing

- Add/extend unit tests in `tests/workspace-registry_test.ts`:
  - accepts `"local"` and valid IANA timezone values
  - rejects invalid timezone values
  - default fallback is `"local"` when missing
- Add/extend runtime tests in `tests/daemon-runtime_test.ts`:
  - generated filenames include `timestampISO8601` in configured timezone
  - generated filenames include `timestampHumane` in configured timezone
  - generated filenames include `snippetSlug` derived from session snippet text
  - missing snippet falls back to non-empty placeholder slug
- Add a DST-sensitive assertion using a fixed instant and explicit timezone
  (for example `America/Los_Angeles`) to verify offset correctness.
- Run:
  - `deno task test`
  - `deno task check`
  - `deno task ci`

## Non-Goals

- Adding arbitrary user-defined date format strings.
- Rewriting existing recorded filenames on disk.
- Expanding template tokens beyond timestamp-related changes in this task.
- Introducing a new third-party time library unless runtime APIs prove
  insufficient.

## Implementation Plan

- [ ] Add `filenameTemplateTimezone` to workspace config parsing and scaffolding
      in `apps/daemon/src/workspace/registry.ts`.
- [ ] Add timezone validation helper and enforce fail-closed errors for invalid
      values.
- [ ] Extend `WorkspaceConfigOverrides` and `ResolvedWorkspaceProfile` to carry
      timezone for filename rendering.
- [ ] Update filename rendering in
      `apps/daemon/src/orchestrator/daemon_runtime.ts` to support
      `{timestampISO8601}`, `{timestampHumane}`, and `{snippetSlug}`.
- [ ] Add session-snippet extraction and slugification logic for
      `{snippetSlug}` with deterministic fallback behavior.
- [ ] Update default filename template constant to use
      `{timestampHumane}`.
- [ ] Update README workspace-config examples and add explicit token docs.
- [ ] Add targeted tests for parsing, rendering, timezone handling, and
      compatibility.
- [ ] Run full validation (`deno task ci`).
