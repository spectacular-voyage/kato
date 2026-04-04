---
id: 6m2r8z1k4p9t5v7n3q1w0yx
title: 2026 04 04 Relative Link Output Sanitization
desc: ""
updated: 1775333389593
created: 1775333389593
---

## Goal

Add relative local-link sanitization to markdown output while keeping twins
authoritative with their original full paths and without retroactively
rewriting existing rendered files.

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

The sanitation is output-only. Twins and persisted source/history data should
continue storing the original/full destinations exactly as ingested. Relative
link rewriting happens only when rendering markdown output for record/capture/
export flows. Already-relative link destinations should be preserved exactly as
authored rather than re-based or reinterpreted.

Rollout should be explicit:

- do not rewrite existing markdown files on disk
- do not mutate twins or provider source history
- do silently apply the new sanitization behavior to future renders for
  already-registered workspaces that omit the new key
- emit both relative-link and Dendron-link writer flags explicitly in newly
  scaffolded workspace config so defaults are visible

Recommended implementation style: focused TDD.

- define and pin the output contract in writer tests first
- add one or two integration tests that prove twins stay authoritative while
  rendered markdown is sanitized
- then implement the minimal writer/config changes needed to make those tests
  pass

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
- persisted destination/source snapshots stay as persisted

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

### Rollout strictness

Do not silently change persisted history or retroactively "normalize" twin
files. That would blur the line between source truth and rendered output.

Do silently change the render behavior for future output in existing workspaces
that omit the new key. This is a product-default decision, not a data-migration
decision.

Do not rewrite previously written markdown output files in place. The change
should only apply the next time Kato renders markdown.

Do not broaden rewriting outside markdown link syntax. That would create false
positives and make output less predictable.

### Recommended TDD scope

I do recommend TDD for this task, but narrowly:

- high value:
  - writer rendering cases
  - Dendron-plus-relative interaction
  - one or two end-to-end recording tests proving twin/output separation
- lower value:
  - trivial boolean plumbing where the behavior is already covered by the
    higher-level tests

This is a good fit because the risk is concentrated in subtle render behavior,
not in novel algorithmic complexity.

## Open Issues

No blocking product/design issues remain for this slice.

Implementation risk to watch:

- Markdown inline-link parsing is intentionally narrow. If implementation
  reveals edge cases around titles, nested parentheses, or other uncommon
  markdown forms, keep this slice scoped to the currently-covered inline
  syntax and spin follow-up work out separately.

## Decisions

- Add a new workspace writer flag for relative local-link sanitation in
  markdown output.
- Apply sanitation only at markdown render time; twins and other persisted
  history remain raw/authoritative.
- Silently enable the new behavior for future renders in existing workspaces
  that omit the new key, while leaving already-written markdown files
  untouched.
- Relativize all local explicit markdown link destinations regardless of target
  extension, not just `.md` files.
- Compute relative destinations from the final output markdown file location.
- Leave external URLs, fragment-only links, and raw prose untouched.
- Keep Dendron mode as a separate composable behavior for local markdown note
  links.
- Keep reference-style links, literal `<...>` autolinks, and plain bare URLs
  out of scope for this task.
- Emit both `writerRelativizeLocalLinks` and
  `writerUseDendronStyleWikilinks` explicitly in new workspace scaffold
  output.
- Develop this task in focused TDD order: writer contract tests first, then
  integration tests for twin/output separation, then minimal implementation.

## Contract Changes

- Workspace config should accept:
  `workspaceFeatureFlags.writerRelativizeLocalLinks: <boolean>`
- New workspace scaffold output should include:
  `writerRelativizeLocalLinks: true`
- New workspace scaffold output should continue including:
  `writerUseDendronStyleWikilinks: false`
- Existing workspaces that omit `writerRelativizeLocalLinks` should resolve as
  if it were enabled for future renders.
- Resolved workspace profiles and persisted workspace output writer flags
  should carry that setting.
- When loading older persisted workspace output state that predates this flag,
  absent persisted values should resolve the same way as an omitted workspace
  config key so daemon/web reload does not silently fall back to legacy output.
- Markdown output rendering should sanitize local explicit link destinations
  without mutating authoritative twin/session history.
- Existing markdown output files already written to disk should not be
  rewritten or migrated.
- Already-relative markdown link/image destinations should remain unchanged in
  output rather than being re-based against workspace root or source-file
  location.
- When both writer flags are enabled:
  - local `.md` note links may render as Dendron wikilinks
  - other local link destinations should render as relative markdown/image
    links

## Testing

- Use focused TDD:
  - write failing writer tests before touching the writer implementation
  - add failing integration tests before threading broader config/runtime
    changes
- Add writer coverage for relative sanitization of:
  - local `.md` links in standard markdown mode
  - local non-`.md` links such as `.pdf` and `.json`
  - local image links such as `.png`
  - mixed content with external URLs and fragment-only links left unchanged
  - already-relative links preserved exactly as-authored
- Add combined-behavior coverage where Dendron note links and relative asset
  links appear in the same rendered output.
- Add web/daemon recording coverage that proves:
  - twin history still stores authoritative full destinations
  - final markdown output is sanitized relative to the destination file
- Add workspace config / session-state coverage for the new writer flag,
  including omitted-key compatibility for older workspace/session state.
- Add scaffold-output coverage that the workspace config template emits both
  `writerRelativizeLocalLinks` and `writerUseDendronStyleWikilinks`
  explicitly.

## Non-Goals

- Rewriting raw path-looking prose outside markdown link syntax
- Rewriting reference-style links, literal `<...>` autolinks, or plain bare
  URLs
- Mutating stored twin events or provider source files
- Changing JSONL export payloads
- Solving link breakage after users manually move output files later
- Rewriting external URLs into relative paths
- Expanding this task into label-preserving Dendron alias syntax

## Implementation Plan

- [x] Add focused failing writer tests for standard-relative rendering,
      non-`.md` local links, image links, already-relative passthrough,
      external/fragment passthrough, and Dendron-plus-relative interaction.
- [x] Add one or two failing daemon/web integration tests proving twins retain
      full/original paths while emitted markdown output is sanitized relative
      to the destination file.
- [x] Add the workspace config contract and scaffold support for
      `writerRelativizeLocalLinks`, and make scaffold output explicitly include
      both that key and `writerUseDendronStyleWikilinks`.
- [x] Thread the new writer flag through resolved workspace profiles and
      persisted workspace output state, including omitted-key compatibility for
      pre-flag workspace/session metadata.
- [x] Refactor markdown link sanitation so render-time rewriting can use the
      destination output path as the relativization base.
- [x] Relativize local standard-link and image-link destinations regardless of
      file extension when the new flag is enabled.
- [x] Preserve Dendron wikilink rendering for local `.md` note links when both
      flags are enabled, while still relativizing non-note local assets.
- [x] Run focused test slices first, then broader `deno task check --frozen`
      once behavior is green.
- [x] Update [[dev.codebase-overview]] and [[dev.decision-log]] if the final
      implementation changes the documented writer contract.
