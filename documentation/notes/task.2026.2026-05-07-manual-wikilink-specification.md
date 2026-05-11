---
id: bms2mage91xx4le17fd4imq
title: 2026 05 07 Manual Wikilink Specification
desc: ''
updated: 1778139291083
created: 1778139291083
---

## Goal

Allow workspace config to manually extend or override the roots that are
eligible for Dendron-style wikilink rendering, so embedded workspaces and
non-Dendron markdown collections can opt into broader wikilink conversion
without depending only on nearest-ancestor `dendron.yml` discovery.

## Summary

Kato currently derives `wikilinkifiableRoots` automatically when
`workspaceFeatureFlags.writerUseDendronStyleWikilinks` is enabled. The resolver
walks upward from the final markdown output path, finds the first ancestor
`dendron.yml` whose derived vault roots contain that output file, and rewrites
eligible local `.md` links inside those roots to `[[note]]`.

That is a good default, but it is too narrow for embedded workspaces. For
example, a workspace may live inside a dependency repo that has its own
`dendron.yml`, while the operator actually wants links to resolve against a
larger parent workspace that mounts the dependency plus additional vaults.
Users may also want wikilink conversion for markdown note trees that are not
Dendron vaults at all.

Add workspace-local wikilink context configuration with two complementary
controls:

- `wikilinks.dendronConfigPath`: explicitly choose a `dendron.yml` whose vault
  roots should be used for wikilink eligibility.
- `wikilinks.additionalRoots`: append explicit local note roots that should be
  treated as wikilinkable, regardless of whether they came from Dendron.

The default behavior should remain unchanged for workspaces that omit the new
keys.

## Discussion

### Why not just keep recursing upward?

Continuing past the first matching `dendron.yml` sounds attractive for the
embedded-repo case, but it changes the meaning of nested Dendron workspaces.
A nested config may be intentionally narrower than its parent, and automatic
ancestor unioning would make unrelated parent vaults eligible for wikilinks
without the workspace opting into that broader context.

Explicit configuration is less magical and easier to explain:

- use current discovery when the nearest matching Dendron context is correct
- use `wikilinks.dendronConfigPath` when another Dendron workspace should be
  the source of truth
- use `wikilinks.additionalRoots` when the desired roots are not represented by
  one Dendron config, or when the user does not use Dendron

### Motivating embedded workspace case

An embedded archive workspace can have this shape:

```text
weave/
  dendron.yml
  dependencies/github.com/semantic-flow/weave-dev-archive/
    dendron.yml
    notes/
      .kato-workspace-config.yaml
```

The current resolver sees the archive's own `dendron.yml` first, derives only
the archive note root, and never reaches the parent `weave/dendron.yml` that
mounts the archive alongside other vaults.

For that case, the workspace should be able to say:

```yaml
wikilinks:
  dendronConfigPath: ../../../../dendron.yml
```

If the operator also wants extra ad hoc roots, or the workspace is embedded in
multiple non-Dendron trees, they should be able to add:

```yaml
wikilinks:
  additionalRoots:
    - ../../../../documentation/notes
    - ../other-notes
```

### Path resolution

All new paths should resolve relative to the directory containing the workspace
config file, not relative to process cwd and not relative to `defaultOutputDir`.
That keeps workspace config portable with the workspace directory.

Expanded roots should be normalized to absolute paths in resolved workspace
profiles and diagnostics. The original configured strings should remain only in
the source config file.

### Precedence and composition

The effective wikilink roots should be:

1. roots derived from `wikilinks.dendronConfigPath`, when present
2. otherwise roots from existing automatic Dendron discovery
3. plus `wikilinks.additionalRoots`, when present

This preserves the current default while allowing explicit replacement of the
Dendron source of truth. `additionalRoots` always appends because it is the
escape hatch for mixed or non-Dendron setups.

If `wikilinks.dendronConfigPath` is present but missing, unreadable, malformed,
or derives no existing roots, the workspace config should be invalid rather
than silently falling back to nearest-ancestor discovery. Explicit config should
fail closed so operators notice path drift.

If `additionalRoots` includes a missing or non-directory path, the workspace
config should also be invalid. A typo in a wikilink root can otherwise cause
quietly mixed markdown and wikilink output.

### Relationship to writer feature flags

These keys should not enable wikilink rendering on their own.
`workspaceFeatureFlags.writerUseDendronStyleWikilinks` remains the switch that
chooses Dendron-style output. The new `wikilinks` block only controls the roots
used when that writer flag is enabled.

This keeps behavior clear for users who configure roots in advance but do not
want rendered markdown changed yet.

### Diagnostics

The Workspaces page already exposes the matched `dendron.yml` and derived
`wikilinkifiableRoots` for the default output probe. Extend that surface so an
operator can tell whether roots came from automatic discovery, an explicit
Dendron config, additional manual roots, or a combination.

## Open Issues

No product blockers.

Implementation detail to decide while coding:

- Whether the diagnostics model should expose separate fields for derived
  Dendron roots and manual additional roots, or only the final combined roots
  plus a mode/source label. Separate fields are better for troubleshooting, but
  the UI may only need the combined root list initially.

## Decisions

- Keep nearest-matching Dendron discovery as the default for workspaces that do
  not configure `wikilinks`.
- Add `wikilinks.dendronConfigPath` to let a workspace choose a specific
  `dendron.yml` as the source for derived wikilink roots.
- Add `wikilinks.additionalRoots` to append explicit note roots for non-Dendron
  or multi-embedding cases.
- Resolve `wikilinks` paths relative to the workspace config file directory.
- Treat invalid explicit wikilink config as invalid workspace config rather
  than silently falling back.
- Do not let these keys enable wikilink output by themselves; the existing
  `writerUseDendronStyleWikilinks` writer flag remains required.
- Do not automatically union every ancestor `dendron.yml`; broader scope should
  be explicit.

## Contract Changes

- Workspace config should accept an optional top-level `wikilinks` object:

```yaml
wikilinks:
  dendronConfigPath: ../dendron.yml
  additionalRoots:
    - ../notes
    - ../shared-notes
```

- `wikilinks.dendronConfigPath`, when present:
  - must be a non-empty string
  - resolves relative to the workspace config directory
  - must point to a readable `dendron.yml` file
  - must parse to at least one existing derived note root
  - replaces automatic Dendron discovery as the Dendron-derived root source for
    this workspace
- `wikilinks.additionalRoots`, when present:
  - must be an array of non-empty strings
  - resolves each path relative to the workspace config directory
  - each resolved path must exist and be a directory
  - appends to the effective wikilink root list
- Effective wikilink root resolution should be:
  - explicit Dendron config roots when `wikilinks.dendronConfigPath` is set
  - otherwise automatic nearest matching Dendron discovery roots
  - plus manual `wikilinks.additionalRoots`
- Workspace scaffolding should include a commented example of the `wikilinks`
  block, not active default roots.
- Resolved workspace diagnostics should expose enough source metadata to
  distinguish automatic discovery, explicit Dendron config, and manual roots.
- Persisted workspace output state should preserve the already-resolved writer
  behavior for active recordings across daemon restart. If this requires
  storing resolved wikilink roots or source config metadata, define that
  compatibility rule before implementation.

## Testing

- Add workspace config parser tests for:
  - valid `wikilinks.dendronConfigPath`
  - valid `wikilinks.additionalRoots`
  - both keys combined
  - paths resolved relative to `.kato-workspace-config.yaml`
  - malformed `wikilinks` object
  - empty string paths
  - missing explicit Dendron config
  - malformed explicit Dendron config
  - explicit Dendron config with no existing derived note roots
  - missing or non-directory additional root
- Add Dendron context tests proving:
  - default nearest-matching discovery remains unchanged
  - explicit `dendronConfigPath` can select a parent config instead of a nested
    config
  - `additionalRoots` allow wikilinks outside Dendron-derived roots
  - automatic ancestor unioning does not happen without explicit config
- Add markdown writer tests proving links into manual roots become wikilinks
  when `writerUseDendronStyleWikilinks` is enabled.
- Add daemon/web integration coverage for a workspace whose default output root
  is inside a nested Dendron workspace but whose explicit config points to a
  parent multi-vault `dendron.yml`.
- Add Workspaces loader/UI tests for the new diagnostics fields.
- Run focused tests first, then `deno task check --frozen`.

## Non-Goals

- Automatically unioning all ancestor `dendron.yml` files.
- Making `additionalRoots` affect write permission or allowed output roots.
- Enabling wikilink rendering without
  `workspaceFeatureFlags.writerUseDendronStyleWikilinks`.
- Supporting remote or URL-based wikilink roots.
- Rewriting existing markdown files in place solely because root configuration
  changed.
- Implementing Dendron cross-vault link labels or vault-qualified wikilinks.
- Solving duplicate note-name ambiguity across multiple roots.

## Implementation Plan

- [ ] Add workspace config schema/types for optional `wikilinks` settings,
      including path validation and config-directory-relative resolution.
- [ ] Extend Dendron context resolution so callers can pass an explicit
      `dendronConfigPath` and/or `additionalRoots`.
- [ ] Thread resolved wikilink settings through workspace profiles, daemon
      render options, web session recording actions, and any persisted
      workspace output state needed for restart compatibility.
- [ ] Preserve current automatic nearest-matching discovery for workspaces that
      omit `wikilinks`.
- [ ] Update markdown writer coverage for links into manual additional roots
      and explicit parent-Dendron roots.
- [ ] Update workspace config, Dendron context, daemon/web integration, and
      Workspaces diagnostics tests.
- [ ] Add scaffold comments showing the optional `wikilinks` block without
      enabling extra roots by default.
- [ ] Update [[dev.codebase-overview]] and [[dev.decision-log]] with the final
      wikilink root contract.
- [ ] Run focused test slices and `deno task check --frozen`.
