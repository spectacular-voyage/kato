---
id: task-2026-07-11-coderabbit-review-fixes
title: CodeRabbit Review Fixes for v0.2.14
desc: Validate and address the still-applicable review findings on PR 43.
updated: 1783804643000
created: 1783804643000
---

## Goal

Verify the CodeRabbit findings on PR 43 against the current branch, fix only the findings that remain valid, and preserve existing behavior while removing correctness risks and avoidable duplication.

## Summary

The review spans output-title metadata merging, release-note version ownership, defensive cloning, live form state, frontmatter parsing, shared config cloning, tag-field parsing, workspace profile resolution, app dependency boundaries, Claude sub-agent parse options, and frontmatter update error handling. Each comment must be checked against current code because several refer to code outside the latest diff or to refactoring opportunities rather than confirmed defects.

## Discussion

Correctness findings take priority over cleanup. Small shared helpers are appropriate when they remove genuinely duplicated behavior without widening public contracts unnecessarily. The workspace output-path helper is pure runtime behavior and should not require Kato Web to import daemon internals.

## Finding Disposition

All supplied findings remained valid against `961350b`; none were skipped.

1. Output creation bypassed inherited `displayTitle`; fixed to use effective metadata. The adjacent inherited `filenameSlug` bypass was fixed at both destination call sites, and untouched inherited values now survive the browser form without being materialized as direct overrides.
2. Title/filename and patched-Vite items introduced after `v0.2.13` were moved into the `v0.2.14` release notes.
3. `WorkspaceProfileResolver` cache copies shared tag arrays; fixed with one deep-enough profile clone helper on cache storage and returns.
4. Sessions polling could overwrite a typed title; fixed with independent title and filename customization state transitions.
5. Frontmatter detection/parsing was duplicated; consolidated behind a private fail-closed parser without changing delimiter or body-slicing behavior.
6. User-config cloning was duplicated; the canonical deep clone is now exported from `user_config.ts` and reused by settings mutations.
7. Session-route tag parsing was duplicated; consolidated while preserving absent-versus-present-empty edit semantics.
8. Sessions profile projection resolved the same workspace twice per request; one concurrent request-scoped profile map now feeds rows and workspace options while retaining both fallback paths.
9. Web workspace loaders imported daemon path internals; pure path-template ownership moved to Kato Runtime with a daemon compatibility export.
10. Claude sub-agent sidechain options were duplicated; one narrow helper now serves live ingestion, source replay, and manual persisted ingestion.
11. Workspace profile lookup in session metadata actions was duplicated; consolidated while retaining persisted output snapshot fallbacks.
12. Frontmatter update failures were all mislabeled as missing files; only `NotFound` maps to `missing-file`, and other errors propagate.

## Open Issues

- None. The supplied review asks to address every finding that remains valid and to skip stale findings with a brief reason.

## Decisions

- Work from the current PR 43 code and thread state, not line numbers alone.
- Keep fixes traceable to the review clusters and add focused regression coverage for behavioral bugs.
- Do not reply to or resolve GitHub review threads unless explicitly requested.
- Preserve missing/invalid-frontmatter behavior while extracting helpers.
- Move pure workspace path-template ownership to the runtime package and retain a daemon compatibility export where useful.

## Contract Changes

- Kato Runtime owns and exports the pure workspace output-path template helpers currently implemented under the daemon.
- No persisted schema, route, or user-facing configuration contract changes are expected.

## Testing

- Cover effective session-default titles during output creation.
- Cover cached workspace tag-array isolation and live title customization state.
- Keep frontmatter parsing/update behavior and tag parsing behavior covered after helper extraction.
- Cover non-`NotFound` frontmatter update failures propagating instead of being mislabeled.
- Run focused suites, type/lint/format checks, and the full CI gate.

## Non-Goals

- Do not redesign the workspace profile cache or Sessions forms beyond the reported findings.
- Do not change provider sub-agent classification semantics.
- Do not post review replies, resolve threads, push, or merge the PR.

## Implementation Plan

- [x] Audit all supplied findings against current code and record valid/skipped results.
- [x] Fix correctness issues in title merging, cache isolation, live form state, and error classification.
- [x] Apply minimal deduplication and dependency-boundary refactors that remain valid.
- [x] Correct release-note version ownership.
- [x] Add or update focused regression tests and documentation.
- [x] Run focused validation and the full CI gate.
