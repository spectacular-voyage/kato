---
id: 1zqr9jdj0bduxzy211bntpb
title: 2026 04 04 Dendron Style Link
desc: ''
updated: 1775333389593
created: 1775333389593
---

## Goal

Add a workspace-local switch so markdown recordings can render local markdown
file references as Dendron wikilinks instead of standard markdown links.

## Summary

Kato now supports a workspace config flag,
`workspaceFeatureFlags.writerUseDendronStyleWikilinks`, defaulting to `false`.
When enabled, workspace-scoped markdown output rewrites local `.md` inline
links such as `[dev.general-guidance.md](/abs/path/dev.general-guidance.md)` to
`[[dev.general-guidance]]`. Heading fragments are preserved as
`[[note#fragment]]`. External URLs and fragment-only links stay unchanged.

## Discussion

- The primary driver is security/sanitation: recorded markdown should not leak
  absolute filesystem paths when the workspace is a Dendron vault.
- This belongs in `workspaceFeatureFlags`, not `markdownFrontmatter`, because
  it changes rendered body content rather than frontmatter structure.
- The rewrite is intentionally conservative:
  - only inline markdown links targeting local `.md` files are rewritten
  - external URLs, `#fragment` links, and query-bearing links are left alone
  - the resulting Dendron target uses the note filename without `.md`

## Open Issues

- No implementation blocker remains.
- If we later want label-preserving Dendron alias syntax like
  `[[note|Custom Label]]`, that should be a follow-up, not part of this first
  sanitary rewrite.

## Decisions

- Use a new workspace-level writer flag:
  `workspaceFeatureFlags.writerUseDendronStyleWikilinks`.
- Keep the default off for backward compatibility.
- Apply the rewrite in the markdown writer so it covers record/capture/export
  paths that already flow through workspace output overrides.

## Contract Changes

- Workspace config now accepts:
  `workspaceFeatureFlags.writerUseDendronStyleWikilinks: <boolean>`
- Resolved workspace profiles and persisted workspace output writer flags now
  carry that setting.
- When enabled, local markdown note links render as Dendron wikilinks using the
  target note filename, without the `.md` extension.

## Testing

- Added follow-up coverage for non-message markdown render surfaces and a
  twin-backed web capture path that verifies final file content under the
  workspace flag.
- `deno test -A --quiet tests/writer-markdown_test.ts tests/workspace-registry_test.ts tests/daemon-cli_test.ts tests/daemon-runtime_test.ts`
- `deno test -A --quiet tests/web-session-actions_test.ts`
- `deno task check --frozen`

## Non-Goals

- Adding the same toggle to shared/global CLI export defaults.
- Rewriting non-markdown links.
- Rewriting raw paths that are not already markdown links.
- Preserving custom markdown-link labels via Dendron alias syntax.

## Implementation Plan

- [x] Add the workspace config contract and scaffold default for a Dendron
  wikilink writer flag.
- [x] Thread the workspace flag through runtime/web output override generation.
- [x] Rewrite local `.md` inline links to Dendron wikilinks in markdown writer
  render paths.
- [x] Add focused tests for writer behavior and workspace-config/runtime
  propagation.
- [x] Expand coverage to non-message render paths and a web capture flow that
  writes Dendron links from persisted twin history.
- [x] Record the decision and contract in developer notes.
