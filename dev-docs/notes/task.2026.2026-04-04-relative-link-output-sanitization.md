---
id: 6m2r8z1k4p9t5v7n3q1w0yx
title: 2026 04 04 Relative Link Output Sanitization
desc: ''
updated: 1775333389593
created: 1775333389593
---

## Goal

Add a workspace-local markdown-output option that sanitizes local link
destinations by emitting relative paths in recorded markdown, while keeping
persisted twins authoritative with their original full paths.

## Summary

This is the follow-up to
[[completed.2026.2026-04-04-dendron-style-links]] for the standard markdown
case.

Kato should support a workspace writer flag that relativizes local link
destinations in emitted markdown output. This must apply to all explicit local
markdown link targets, not just `.md` notes:

- standard links like `[label](...)`
- image links like `![alt](...)`
- local assets such as `.pdf`, `.png`, `.json`, `.txt`, and `.md`

The sanitation is output-only. Twins and other persisted session state should
continue storing the original/full destinations exactly as ingested. Relative
link rewriting happens only when rendering markdown output for record/capture/
export flows.

## Discussion

### Why this is separate from the Dendron task

The Dendron task solved one narrow sanitation problem: local markdown note
links could render as `[[note]]` instead of leaking absolute paths. That is
useful for Dendron vaults, but it does not cover the broader standard-markdown
case where operators still want portable/sanitary output without switching to
wikilinks.

This follow-up is broader:

- sanitize all local explicit markdown link destinations, regardless of target
  file type
- keep external URLs alone
- keep the underlying twin/source data untouched

### Authoritative data vs. sanitized output

The authoritative session history should remain raw:

- provider source stays as ingested
- twins stay as persisted
- session metadata stays as persisted

The markdown writer is the right place to sanitize because it already owns the
rendered output format and already receives the destination file path. That
lets us compute relative destinations from the final output location without
polluting persisted data or weakening replay fidelity.

### Scope of "all links"

"All links" should mean all explicit markdown link destinations rendered by the
writer, not arbitrary path-like text in prose. Concretely:

- rewrite local `[label](dest)` links when `dest` is a local path
- rewrite local `![alt](dest)` image links when `dest` is a local path
- preserve external destinations such as `https:`, `mailto:`, and other
  scheme-based URLs
- preserve fragment-only links such as `#section`
- do not attempt to rewrite raw text that only looks like a path

That keeps the sanitation rule mechanical and testable instead of heuristic.

### Base path for relativization

Relative destinations should be computed from `dirname(outputPath)`, where
`outputPath` is the markdown file being written.

Implications:

- absolute local paths can be safely relativized
- already-relative link destinations are already sanitized enough and should be
  preserved as-authored
- later moving the output file can still break relative links, but that is an
  accepted tradeoff of portable markdown and should not be "fixed" by
  preserving absolute filesystem paths in output

### Interaction with Dendron mode

This feature should not replace Dendron mode. The two behaviors should compose:

- if `writerUseDendronStyleWikilinks` is on, local `.md` note links still
  render as Dendron wikilinks
- if relative-link sanitation is on, the remaining local link destinations
  render as relative markdown/image links

That gives a Dendron vault the best of both:

- note-to-note links become `[[note]]`
- assets like images and PDFs stop leaking absolute paths

### Recommended rollout strictness

I do not recommend silently changing persisted history or retroactively
"normalizing" twin files. That would blur the line between source truth and
rendered output.

I also do not recommend broad text rewriting outside markdown link syntax. That
would create false positives and make output less predictable.

## Open Issues

- Flag naming:
  - Recommended answer: use
    `workspaceFeatureFlags.writerRelativizeLocalLinks`.
- Default rollout:
  - Recommended answer: do not silently change existing workspaces that omit
    the key.
  - If we want this to become the product default, prefer doing that through
    workspace scaffold output first rather than changing absent-config behavior
    for already-registered workspaces.
- Already-relative paths emitted by models:
  - Recommended answer: preserve them as-authored instead of trying to
    reinterpret them against workspace root or source-file location.
- Link syntax scope:
  - Recommended answer: cover explicit inline markdown link/image syntax first.
    Reference-style links or raw autolinks can be a separate follow-up if we
    decide they matter.

## Decisions

- Add a new workspace writer flag for relative local-link sanitation in
  markdown output.
- Apply sanitation only at markdown render time; twins and other persisted
  history remain raw/authoritative.
- Relativize all local explicit markdown link destinations regardless of target
  extension, not just `.md` files.
- Compute relative destinations from the final output markdown file location.
- Leave external URLs, fragment-only links, and raw prose untouched.
- Keep Dendron mode as a separate composable behavior for local markdown note
  links.

## Contract Changes

- Workspace config should accept:
  `workspaceFeatureFlags.writerRelativizeLocalLinks: <boolean>`
- Resolved workspace profiles and persisted workspace output writer flags
  should carry that setting.
- Markdown output rendering should sanitize local explicit link destinations
  without mutating authoritative twin/session history.
- When both writer flags are enabled:
  - local `.md` note links may render as Dendron wikilinks
  - other local link destinations should render as relative markdown/image
    links

## Testing

- Add writer coverage for relative sanitization of:
  - local `.md` links in standard markdown mode
  - local non-`.md` links such as `.pdf` and `.json`
  - local image links such as `.png`
  - mixed content with external URLs and fragment-only links left unchanged
- Add combined-behavior coverage where Dendron note links and relative asset
  links appear in the same rendered output.
- Add web/daemon recording coverage that proves:
  - twin history still stores authoritative full destinations
  - final markdown output is sanitized relative to the destination file
- Add workspace config / session-state coverage for the new writer flag.

## Non-Goals

- Rewriting raw path-looking prose outside markdown link syntax
- Mutating stored twin events or provider source files
- Changing JSONL export payloads
- Solving link breakage after users manually move output files later
- Rewriting external URLs into relative paths
- Expanding this task into label-preserving Dendron alias syntax

## Implementation Plan

- [ ] Add the workspace config contract and scaffold support for
      `writerRelativizeLocalLinks`.
- [ ] Thread the new writer flag through resolved workspace profiles and
      persisted workspace output state.
- [ ] Refactor markdown link sanitation so render-time rewriting can use the
      destination output path as the relativization base.
- [ ] Relativize local standard-link and image-link destinations regardless of
      file extension when the new flag is enabled.
- [ ] Preserve Dendron wikilink rendering for local `.md` note links when both
      flags are enabled, while still relativizing non-note local assets.
- [ ] Add focused writer tests for standard-relative, Dendron-plus-relative,
      and external-link passthrough behavior.
- [ ] Add daemon/web integration coverage proving twins retain full paths while
      emitted markdown output is sanitized.
- [ ] Update [[dev.codebase-overview]] and [[dev.decision-log]] if the final
      implementation changes the documented writer contract.
