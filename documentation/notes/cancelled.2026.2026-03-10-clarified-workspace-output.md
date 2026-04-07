---
id: 3yd8snm9mpwwk6bv2iilov6
title: 2026 03 10 Clarified Workspace Output
desc: ''
updated: 1773175587222
created: 1773175587222
---

## Goal

Clarify workspace output configuration and command destination behavior so
generated directory policy, generated filename policy, and explicit path
overrides each have one clear responsibility.

## Summary

- Keep the split generated-output model.
- Rename workspace config `filenameTemplate` to `defaultFilenameTemplate`.
- Treat that rename as breaking in both workspace config and persisted session
  metadata snapshots.
- Keep `defaultOutputDir` as the generated directory policy; it remains the
  place where dated/provider/user subfolders belong.
- Keep `defaultFilenameTemplate` filename-only and use it for pathless commands
  and explicit directory targets.
- Change bare explicit relative filenames like `::capture-k foo.md` to resolve
  inside the rendered `defaultOutputDir` instead of directly from
  `workspaceRoot`.
- Keep explicit relative paths that already include a directory
  (`drafts/foo.md`) workspace-root-relative.
- Keep explicit absolute paths allowed.
- Fail closed when generated defaults derived from `defaultOutputDir` would
  escape `workspaceRoot`.
- Defer profile-by-directory or multi-output-profile design.

## Discussion

The earlier `outputPathTemplate` direction makes the model harder to explain
because it overlaps with `defaultOutputDir` and creates ambiguity for directory
targets such as `::capture-k drafts/`. The current split already has a usable
separation of concerns:

- `defaultOutputDir` decides where generated files go.
- `filenameTemplate` decides the generated leaf filename.

The main problem is naming and one path-resolution edge:

- `filenameTemplate` sounds broader than it is, even though the runtime already
  flattens path separators and treats it as a basename.
- Bare explicit filenames currently resolve from `workspaceRoot`, which makes
  them behave differently from both pathless commands and explicit directory
  targets.

The clarified model should therefore be:

- rename `filenameTemplate` to `defaultFilenameTemplate`
- keep generated subfolder logic in `defaultOutputDir`
- keep filename generation logic in `defaultFilenameTemplate`
- make bare explicit filenames inherit `defaultOutputDir`

That preserves a clear mental model while avoiding a larger redesign around
output profiles or path-aware filename templates.

### Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| `::record-k` / `::capture-k` / `::export-k` with no path | Yes | Yes | Yes | Continue resolving to `workspaceRoot + rendered defaultOutputDir + rendered defaultFilenameTemplate`. |
| Explicit directory target like `drafts/` | Yes | Yes | Yes | Continue appending the rendered generated filename to the explicit directory target. |
| Bare explicit relative filename like `foo.md` | Yes | Yes | No | New behavior: resolve to `rendered defaultOutputDir/foo.md` instead of `workspaceRoot/foo.md`. |
| Explicit relative path with directory like `drafts/foo.md` | Yes | Yes | Yes | Continue treating it as an exact workspace-root-relative file target. |
| Explicit absolute path like `/tmp/foo.md` | Yes | Yes | Yes | Continue allowing explicit absolute overrides, subject to write-path policy. |
| Generated default dir escapes workspace via `../` | Yes | Yes | No | New behavior: reject generated destination resolution instead of allowing an escaped path that later relies on broader write-root policy. |

## Open Issues

- Future output-profile support is intentionally deferred. If Kato later needs
  multiple generated output rules per workspace, that should be designed as a
  separate feature with explicit selection semantics rather than folded into
  this rename.
- The current workspace-root invariant remains unchanged: one workspace root per
  registered workspace, anchored by the directory containing
  `.kato-workspace-config.yaml`.

## Decisions

- Keep `defaultOutputDir` and a separate filename-only template.
- Rename `filenameTemplate` to `defaultFilenameTemplate`.
- Make the rename breaking; do not support long-term dual keys.
- Preserve explicit absolute-path support.
- Preserve workspace-root-relative semantics for explicit relative paths that
  already contain directories.
- Route bare explicit relative filenames through `defaultOutputDir`.
- Reject generated default destinations that escape `workspaceRoot`.
- Defer directory/profile-based output selection as out of scope.

## Contract Changes

- Workspace config:
  - rename `filenameTemplate` to `defaultFilenameTemplate`
  - keep `defaultOutputDir`
  - reject legacy `filenameTemplate` once this task lands
- Runtime/profile contracts:
  - rename `ResolvedWorkspaceProfile.filenameTemplate` to
    `defaultFilenameTemplate`
  - keep `resolvedDefaultOutputDir`
- Persisted session metadata:
  - rename workspace output snapshot field `filenameTemplate` to
    `defaultFilenameTemplate`
  - treat this as a schema/compatibility break rather than a dual-read
    transition
- Destination resolution contract:
  - pathless command: generated dir + generated filename
  - explicit directory target: explicit directory + generated filename
  - bare explicit relative filename: generated dir + explicit filename
  - explicit relative path with separators: exact workspace-root-relative path
  - explicit absolute path: exact absolute path

## Testing

- Extend workspace config parser/resolver tests to cover:
  - `defaultFilenameTemplate` loading and scaffolding
  - legacy `filenameTemplate` rejection
  - `defaultOutputDir` token rendering still supporting subfolders
  - generated default-dir escape rejection
- Extend workspace path tests to cover:
  - unchanged generated filename rendering
  - unchanged pathless resolution
  - unchanged explicit directory-target behavior
- Extend command destination tests to cover:
  - bare explicit filename now resolving inside `defaultOutputDir`
  - explicit nested relative file path remaining workspace-root-relative
  - explicit absolute path remaining unchanged
- Extend runtime/session-state tests to cover:
  - persisted workspace output snapshots using `defaultFilenameTemplate`
  - restart/retarget behavior preserving current destination semantics after the
    rename

## Non-Goals

- Adding multiple named output profiles within a workspace.
- Changing the workspace registration/root model.
- Disallowing explicit absolute paths.
- Making the generated filename template path-aware.
- Reworking unrelated frontmatter, username, or writer-feature behavior.

## Implementation Plan

- [ ] Update workspace config parsing, validation, scaffolding, and default
      template generation to rename `filenameTemplate` to
      `defaultFilenameTemplate`, and reject the legacy key.
- [ ] Update runtime workspace-profile contracts and helper names to use
      `defaultFilenameTemplate` consistently.
- [ ] Keep `defaultOutputDir` as the generated directory source and add
      fail-closed validation so generated default destinations cannot escape
      `workspaceRoot`.
- [ ] Update command destination resolution so bare explicit relative filenames
      resolve under `resolvedDefaultOutputDir`, while directory targets,
      nested relative paths, and absolute explicit paths keep the agreed
      behavior.
- [ ] Rename persisted workspace-output snapshot fields from `filenameTemplate`
      to `defaultFilenameTemplate` and update session-state validation,
      projection, and resume paths accordingly.
- [ ] Update README and developer docs to reflect the clarified model,
      especially the semantics of `defaultOutputDir`, `defaultFilenameTemplate`,
      and bare explicit filenames.
- [ ] Add or update focused tests for config parsing, path resolution, runtime
      persistence, and command-resolution regressions.
