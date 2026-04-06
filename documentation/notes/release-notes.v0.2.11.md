---
id: oi8zsjo97cpmsoopqiqkgn9
title: 'Release Notes v0.2.11'
desc: >-
  Portable workspace markdown links, vault-aware Dendron wikilinks, and
  testing/release workflow polish.
updated: 1775405732652
created: 1775405732652
---

## Summary

`v0.2.11` is a workspace-markdown release. It makes captured and recorded
markdown output more portable by default, adds an opt-in Dendron wikilink mode
for workspace recordings, and then tightens that Dendron behavior so only real
note-tree targets collapse to `[[note]]` syntax. It also fixes split-coverage
reporting for Codecov and updates the release runbook around the current manual
release workflow.

## User-facing Changes

- workspace markdown output now rewrites absolute local inline links and image
  destinations to paths relative to the rendered output file, so captures and
  recordings stop leaking absolute filesystem paths into saved markdown
- relative-link sanitization is now the default behavior for workspace-scoped
  markdown rendering, including older workspaces that did not explicitly carry
  the new flag yet
- workspace config now supports `writerUseDendronStyleWikilinks`, which lets
  local markdown note links collapse to Dendron `[[note]]` syntax in
  workspace-scoped markdown output
- Dendron rewriting is now vault-aware: Kato walks upward from the final
  output path, discovers a matching `dendron.yml`, derives note roots from the
  configured vaults, and only rewrites `.md` targets inside those roots
- links to non-note markdown files such as a repo `README.md` now stay normal
  markdown links even when Dendron wikilinks are enabled, while non-markdown
  assets still sanitize to relative markdown/image paths
- the Workspaces page now shows matched `dendron.yml` context and derived
  `wikilinkifiableRoots` as read-only diagnostics for the workspace default
  output area

### Upgrade notes

- existing workspaces now sanitize absolute local inline markdown
  links/images in future renders by default; set
  `workspaceFeatureFlags.writerRelativizeLocalLinks: false` only if you
  intentionally want absolute local paths in generated markdown
- `writerUseDendronStyleWikilinks` remains opt-in and still defaults to
  `false` in new workspace scaffolds
- if you already enabled Dendron wikilinks, the rewrite scope is now narrower:
  only note targets inside discovered Dendron note roots rewrite, with a
  same-directory fallback when no matching Dendron context is found
- no source-of-truth migration is involved: twins, provider history, and
  already-written markdown files are not rewritten in place

## Developer-oriented Changes

- split root coverage now writes parallel-safe and env-boundary raw coverage
  into separate directories and merges both into the final `coverage.lcov`,
  fixing the false-low patch coverage that previously showed up in Codecov
- the release docs are now centered on `.github/workflows/release-manual.yml`,
  with the current draft-vs-publish flow, auto-created release-tag behavior,
  and `deno task bump:version` stub generation documented as the primary path
- release-note scaffolding/docs were refreshed so version bumps create the
  expected `release-notes.v<version>.md` stub and the GitHub Release body keeps
  pulling from that note after Dendron frontmatter stripping
- CI dependency bumps updated `codecov/codecov-action` from `v5` to `v6` and
  the reusable `google/osv-scanner-action` workflows from `v2.3.3` to
  `v2.3.5`
