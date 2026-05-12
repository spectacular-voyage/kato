---
id: zd9ztxjin0cq3dawfzwj4wu
title: 2026 04 05 Dendron Vault Awareness
desc: ''
updated: 1775403963204
created: 1775403464469
---

## Goal

Make Dendron wikilink rewriting vault-aware so Kato only emits `[[note]]`
syntax for markdown targets that actually live inside a discovered Dendron note
directory, and expose the derived roots in the web workspace page for debugging.

## Summary

This is a follow-up to [[ka.completed.2026.2026-04-04-dendron-style-links]] and
[[task.2026.2026-04-04-relative-link-output-sanitization]].

Kato currently treats any local `.md` inline link as Dendron-wikilinkable when
`workspaceFeatureFlags.writerUseDendronStyleWikilinks` is enabled. That is too
broad: links to repo markdown like `README.md` can be rewritten even when the
target is not part of a Dendron note tree.

The new rule should be:

- start from the final markdown `outputPath`
- walk upward looking for an ancestor `dendron.yml`
- for each discovered config, resolve `workspace.vaults[].fsPath` relative to
  the directory containing that `dendron.yml`
- derive note roots from each vault using:
  - `selfContained: true` => `<fsPath>/notes`
  - otherwise => `<fsPath>`
- keep the first Dendron config whose derived roots contain the output file as
  the active Dendron context for that render
- track all derived note roots from that matching config as
  `wikilinkifiableRoots`
- only rewrite `.md` inline links to Dendron wikilinks when their resolved
  target path falls inside one of those roots

If no matching Dendron context is found, Kato should fall back to a narrow
same-directory rule: only `.md` links whose resolved target path lives in the
same directory as the rendered output file should rewrite to Dendron
wikilinks. Relative-link sanitization can still run independently.

For operator visibility, the web workspace page should show the derived
`wikilinkifiableRoots` and the matched `dendron.yml` path when available.

## Discussion

### Why the current behavior is too broad

The current Dendron writer mode keys off "local `.md` link" instead of "link
to a note inside a Dendron note tree". That makes absolute-path sanitation look
correct in many cases, but it also rewrites non-note markdown files such as
repo `README.md` files.

This is a correctness problem, not just a cosmetic one. A plain markdown file
outside the note tree should remain a markdown link, not be collapsed into a
Dendron note id that may not resolve.

### Dendron context should come from the output path

The correct discovery anchor is the final markdown destination, not the source
session file and not a global daemon-wide assumption.

Why:

- the same daemon can write to multiple workspaces
- explicit output paths can differ from the workspace default output dir
- the writer already knows the final rendered destination path

So the Dendron question is: "does this rendered output live inside a Dendron
workspace, and if so which note roots belong to that workspace?"

### Vault-root derivation

Use a narrow derivation rule rather than trying to understand all of Dendron:

- resolve `workspace.vaults[].fsPath`
- if `selfContained` is `true`, treat the note root as `<vaultRoot>/notes`
- otherwise treat the note root as `<vaultRoot>`

That matches the local repo layout and the intended multi-vault example where
`fsPath` is the important source of truth, with one extra adjustment for
self-contained vaults.

This task should not expand into full Dendron publishing/site generation
semantics. `siteRootDir`, publishing options, note refs, and block anchors are
not required for this boundary check.

### Matching a Dendron workspace

When walking upward for `dendron.yml`, Kato should keep the first config whose
derived note roots contain the output file path. Once such a config is found,
all note roots declared by that config become the active
`wikilinkifiableRoots` set for that render.

That gives a multi-vault Dendron workspace one shared eligibility boundary
without assuming the whole machine is a Dendron installation.

If no matching Dendron workspace is found, the fallback boundary should be the
rendered output file's own directory, not the whole workspace root and not the
whole repo. That keeps the non-Dendron case narrow and predictable.

### Link eligibility rule

Under Dendron mode:

- resolve relative markdown destinations against `dirname(outputPath)` first
- allow Dendron rewrite only for local `.md` targets inside
  `wikilinkifiableRoots`
- leave `.md` links outside those roots as standard markdown links
- continue leaving external URLs, fragment-only links, query-bearing links,
  and non-markdown assets alone

When no Dendron context matches the output path:

- use `dirname(outputPath)` as the fallback `wikilinkifiableRoots` boundary
- allow Dendron rewrite only for local `.md` targets in that same directory
- leave parent-directory or sibling-directory markdown links as standard
  markdown links

This composes cleanly with relative-link sanitization:

- note links inside Dendron roots may become `[[note]]`
- non-note assets still become relative markdown/image links
- markdown links outside Dendron roots stay markdown links, but may still be
  relativized

### Derived runtime state, not workspace config

`workspaceFeatureFlags.writerUseDendronStyleWikilinks` is still the right
workspace-level intent flag. But the actual `wikilinkifiableRoots` should be
derived runtime state, not stored workspace config.

Reasons:

- the roots depend on the concrete output path and filesystem layout
- `dendron.yml` can change without changing workspace config
- persisting derived roots would make stale-path behavior harder to reason
  about

Recommended implementation approach:

- compute on demand from the output path
- cache the parsed Dendron workspace info in memory by `dendron.yml` path and
  file mtime
- do not persist the derived roots into session state

### Web visibility

The web workspace page is a good place to show the derived Dendron context
because this feature is otherwise hard to debug. A read-only section is enough:

- matched `dendron.yml` path, if any
- derived `wikilinkifiableRoots`
- possibly a short "no matching Dendron workspace found" state

This should be treated as diagnostic visibility, not as an editable config
surface.

## Open Issues

- No product blocker remains for this slice.
- Implemented rule:
  - If `selfContained: true` resolves to `<fsPath>/notes` and that directory
    does not exist, Kato fails closed for that vault by omitting it from
    `wikilinkifiableRoots` instead of guessing.
- Cross-vault note-name collisions are still unresolved when emitting plain
  basename wikilinks.
  - Recommended answer for this slice: use vault roots only as an eligibility
    boundary, keep the existing plain `[[note]]` syntax, and spin any
    collision-aware or x-vault-qualified syntax into follow-up work.

## Decisions

- Keep using `workspaceFeatureFlags.writerUseDendronStyleWikilinks` as the
  user-facing on/off switch.
- Do not add a new workspace config key for Dendron roots.
- Derive `wikilinkifiableRoots` at runtime from the final `outputPath` by
  walking upward for `dendron.yml`.
- Resolve `workspace.vaults[].fsPath` relative to the directory containing the
  matched `dendron.yml`.
- Derive note roots with the rule:
  - `selfContained: true` => `<fsPath>/notes`
  - otherwise => `<fsPath>`
- Treat the first ancestor `dendron.yml` whose derived roots contain the output
  file as the active Dendron context for that render.
- Use all derived note roots from that matched config as the active
  `wikilinkifiableRoots` set.
- If no matching Dendron config is found, fall back to the rendered output
  file's own directory as the only wikilinkifiable scope.
- Resolve relative markdown note destinations against `dirname(outputPath)`
  before checking whether they are inside `wikilinkifiableRoots`.
- Only rewrite `.md` links to Dendron wikilinks when the resolved target is
  inside `wikilinkifiableRoots`.
- Leave `.md` links outside those roots as standard markdown links.
- Keep `wikilinkifiableRoots` as derived runtime state only; do not persist it
  in workspace config or session state.
- Add read-only Dendron diagnostics to the web workspace page showing the
  matched config path and derived roots.

## Contract Changes

- Narrow the meaning of
  `workspaceFeatureFlags.writerUseDendronStyleWikilinks`:
  - before: any local `.md` markdown link could be rewritten
  - after: only local `.md` links whose resolved targets fall inside the
    derived `wikilinkifiableRoots` may be rewritten
  - fallback: when no Dendron config matches, the rendered output file's own
    directory becomes the only wikilinkifiable root
- Introduce a runtime helper that discovers Dendron context from `outputPath`
  and returns:
  - matched `dendronConfigPath`, if any
  - derived `wikilinkifiableRoots`
- Extend markdown render context / output override plumbing so Dendron
  rewriting can consult those derived roots.
- Keep workspace config and persisted session-state schemas unchanged for this
  slice; derived Dendron roots are not persisted.
- Extend the web workspace-page loader/view model to expose read-only Dendron
  diagnostics:
  - `dendronConfigPath?: string`
  - `wikilinkifiableRoots?: string[]`
  - optionally an unavailable/missing state if discovery fails closed

## Testing

- Add writer tests proving:
  - `.md` targets inside a matched Dendron note root rewrite to wikilinks
  - `.md` targets outside those roots stay markdown links
  - relative `.md` links are resolved against the output file before the root
    check
  - when no Dendron config matches, only same-directory `.md` links rewrite
    while parent/sibling-directory markdown links stay standard
  - non-`.md` assets still use relative-link sanitization instead of wikilinks
  - no matching `dendron.yml` uses the same-directory fallback instead of
    disabling Dendron rewriting entirely
- Add discovery-helper tests for:
  - nearest-ancestor `dendron.yml` lookup
  - relative `fsPath` resolution
  - `selfContained: true` => `<fsPath>/notes`
  - non-self-contained vaults using plain `<fsPath>`
  - multi-vault config returning all derived roots from the matched workspace
- Add integration coverage for a workspace note output where:
  - a note link inside the derived note roots becomes a wikilink
  - a sibling repo markdown file such as `README.md` stays a markdown link
- Add web loader / page coverage that the workspace page surfaces matched
  Dendron config info and derived `wikilinkifiableRoots`.
- Run focused slices first, then broader checks:
  - writer and workspace/runtime tests
  - web workspace loader/page tests
  - `deno task check --frozen`

## Non-Goals

- Full Dendron graph parsing, note indexing, or publishing semantics
- X-vault-qualified wikilink syntax or note-collision resolution
- Storing derived Dendron roots in workspace config or persisted session state
- Guessing Dendron note roots when no matching `dendron.yml` is found
- Rewriting non-markdown assets as wikilinks
- Making the web workspace page editable for Dendron roots/config

## Implementation Plan

- [x] Add focused tests for Dendron-context discovery from `outputPath`,
      including ancestor lookup, relative `fsPath` handling, and the
      `selfContained => /notes` rule.
- [x] Add failing writer tests proving `.md` links inside
      `wikilinkifiableRoots` rewrite to `[[note]]` while links outside those
      roots stay markdown links, including the no-Dendron same-directory
      fallback.
- [x] Refactor Dendron link rewriting so it resolves candidate note paths
      against the final output file and checks them against derived
      `wikilinkifiableRoots`.
- [x] Introduce a small cached runtime helper for parsing `dendron.yml` and
      deriving note roots without persisting that state.
- [x] Thread Dendron discovery output through daemon/web markdown render
      contexts without changing workspace config or session-state schemas.
- [x] Extend the web workspace page loader/model to surface matched
      `dendron.yml` and `wikilinkifiableRoots` as read-only diagnostics.
- [x] Run focused tests and then `deno task check --frozen`.
- [x] Update [[dev.codebase-overview]] and [[dev.decision-log]] if the final
      implementation changes the long-term writer/runtime contract.
