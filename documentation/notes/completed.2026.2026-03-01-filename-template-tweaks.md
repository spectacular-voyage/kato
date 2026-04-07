---
id: 4t97owqubbhk7poems1t1va
title: 2026 03 01 Filename Template Tweaks
desc: ''
updated: 1772439219106
created: 1772422088094
---

# Filename Template Tweaks

## Goal

- Replace UTC-only filename token behavior with simpler, timezone-aware filename
  templating.
- Add an explicit workspace config key for filename timestamp timezone.
- Remove in-chat `::init` command support.
- Document supported template tokens and timezone behavior in `README.md`.

## Summary

Current filename rendering only supports `{timestampUtc}` and always uses UTC.
This task replaces timestamp token behavior with:

- `{timestampHumane}` (format `YYYY-MM-DD_HHmm`, for example `2026-03-01_1234`)
- `{snippetSlug}` (slugified session snippet)

This task also adds `filenameTemplateTimezone` to workspace config, with
supported values:

- `"local"` (system timezone of the daemon process)
- an IANA timezone identifier (for example `"America/Los_Angeles"`)
- `"UTC"`

## Discussion

### Current behavior (baseline)

- `apps/daemon/src/orchestrator/daemon_runtime.ts` renders only
  `{timestampUtc}`.
- `apps/daemon/src/workspace/registry.ts` scaffolds
  `filenameTemplate: "{provider}-{sessionShortId}-{timestampUtc}.md"`.
- Workspace config does not currently expose a filename timezone key.

### Proposed token behavior

- `{timestampHumane}`:
  - Timestamp in configured timezone using `YYYY-MM-DD_HHmm`.
  - Example: `2026-03-01_1234`.
  - Intended for shorter, easier-to-read filenames.
- `{snippetSlug}`:
  - Slugified snippet derived from the session snippet.
  - Should be filesystem-safe and lowercase with `-` separators.
  - Leading blank lines should be ignored (reuse existing snippet extraction
    behavior).
  - Fallback chain should be:
    - `snapshot.metadata.snippet` when available
    - `extractSnippet(boundarySnapshot)` at command time
    - stable placeholder `"conversation"`

### Snippet availability

Sessions can still lack a snippet in edge cases, for example:

- no non-empty user message exists yet
- session content contains only assistant/tool/system events
- first user message is blank/whitespace-only

So placeholder fallback remains required, but should be rare.

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
- Remove `{timestampUtc}` and `{timestampISO8601}` everywhere, no backward
  compatibility.
- Workspace configs that still reference removed tokens should fail
  config/profile validation with a clear error.
- README needs updates.

### Command surface changes

- Remove in-chat `::init` and `::init-<alias>` support entirely.
- Keep `::record-<alias>`, `::capture-<alias>`, `::export-<alias>`,
  `::stop[-<alias>]`.
- Rationale: filename generation should happen at record/capture/export command
  time when snippet context exists.

### Library/runtime choice

- No third-party date/time dependency is required.
- Prefer Deno runtime `Intl` APIs for timezone handling/validation:
  - If `Intl.supportedValuesOf("timeZone")` exists, validate against that set.
  - Always validate with `Intl.DateTimeFormat(..., { timeZone })` try/catch as
    runtime fallback.

### Snippet persistence

- Do not add snippet to persistent session `.meta.json` in this task.
- Reuse existing runtime snapshot metadata snippet and command-time fallback
  extraction.
- Revisit persistent snippet in a separate task only if restart-time performance
  indicates need.

## Contract Changes

- Workspace config schema (`kato-workspace-config.yaml` and default template):
  - add optional `filenameTemplateTimezone: string`
  - add key to `WORKSPACE_CONFIG_TOP_LEVEL_KEYS`
  - add key to `WORKSPACE_TEMPLATE_TOP_LEVEL_KEYS`
- Workspace profile resolution contracts:
  - `WorkspaceConfigOverrides` gains `filenameTemplateTimezone?: string`
  - `ResolvedWorkspaceProfile` gains `filenameTemplateTimezone: string`
- Filename renderer token contract:
  - add `{timestampHumane}`
  - add `{snippetSlug}`
  - remove `{timestampUtc}`
  - remove `{timestampISO8601}`
  - update hardcoded renderer fallback literal (currently uses `timestampUtc`)
- Command parsing/runtime contract:
  - remove `init` from in-chat command grammar and runtime handlers
- Documentation contract:
  - README includes a token table with examples and timezone semantics
  - README config examples include `filenameTemplateTimezone`

## Testing

- Add/extend unit tests in `tests/workspace-registry_test.ts`:
  - accepts `"local"` and valid IANA timezone values
  - rejects invalid timezone values
  - default fallback is `"local"` when missing
  - rejects removed/unknown filename template tokens
  - `allowMissing` load path does not treat `filenameTemplateTimezone`-only
    config as empty
- Add/extend runtime tests in `tests/daemon-runtime_test.ts`:
  - generated filenames include `timestampHumane` in configured timezone
  - generated filenames include `snippetSlug` derived from session snippet text
  - snippet extraction ignores leading blank lines
  - missing snippet falls back to non-empty placeholder slug
  - in-chat `::init` / `::init-<alias>` is rejected as unknown/unsupported
- Add a DST-sensitive assertion using a fixed instant and explicit timezone (for
  example `America/Los_Angeles`) to verify offset correctness.
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

- [x] Add `filenameTemplateTimezone` to workspace config parsing and scaffolding
      in `apps/daemon/src/workspace/registry.ts`.
- [x] Add `filenameTemplateTimezone` to workspace key allowlists in
      `apps/daemon/src/workspace/registry.ts`
      (`WORKSPACE_CONFIG_TOP_LEVEL_KEYS`, `WORKSPACE_TEMPLATE_TOP_LEVEL_KEYS`).
- [x] Add timezone validation helper and enforce fail-closed errors for invalid
      values.
- [x] Update `DefaultWorkspaceConfigFileStore.load()` emptiness check to include
      `filenameTemplateTimezone` so timezone-only overrides are not treated as
      empty.
- [x] Extend `WorkspaceConfigOverrides` and `ResolvedWorkspaceProfile` to carry
      timezone for filename rendering.
- [x] Update filename rendering in
      `apps/daemon/src/orchestrator/daemon_runtime.ts` to support
      `{timestampHumane}` and `{snippetSlug}` only.
- [x] Remove renderer support for `{timestampUtc}` and `{timestampISO8601}`, and
      update any fallback filename literals that still reference `timestampUtc`.
- [x] Add session-snippet slugification for `{snippetSlug}` with deterministic
      fallback chain: `snapshot.metadata.snippet` ->
      `extractSnippet(boundarySnapshot)` -> `"conversation"`.
- [x] Remove in-chat `::init` parsing and runtime handling paths.
- [x] Update default filename template constant to use `{timestampHumane}`.
- [x] Update README workspace-config examples and add explicit token docs.
- [x] Add targeted tests for parsing, rendering, timezone handling, and
      compatibility.
- [x] Run full validation (`deno task ci`).
