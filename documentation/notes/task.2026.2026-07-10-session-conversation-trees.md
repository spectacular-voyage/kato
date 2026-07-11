---
id: task-2026-07-10-session-conversation-trees
title: Session Conversation Trees
desc: ""
updated: 1783727400000
created: 1783727400000
---

## Status

The parent/child relationship and recursive tree work remains current. The visibility-mode portions of this task were superseded by [[task.2026.2026-07-11-session-tree-only-inventory]]: Sessions now always uses the grouped tree, and legacy `subagents` query parameters are ignored.

## Goal

Make the Kato Web Sessions inventory manageable by grouping provider-declared sub-conversations beneath their parents in recursively expandable trees that default closed.

## Summary

Claude and Codex expose different but deterministic parent signals. Claude sub-conversation source files live below a parent provider-session directory's exact `subagents` segment. Codex rollout `session_meta` records expose the immediate parent as `payload.source.subagent.thread_spawn.parent_thread_id`, including real depth-two descendants. Kato should use those provider contracts and must not infer relationships from repeated snippets, session names, activity timestamps, or an `agent-*` identifier.

The inclusive Sessions view becomes a grouped tree. Each parent is collapsed by default and reports its descendant count and relevant activity while closed. The later [[task.2026.2026-07-11-session-tree-only-inventory]] decision makes this tree the only presentation and removes the short-lived visibility mode; legacy `subagents` query parameters are ignored.

## Discussion

Collapsing reduces visual density while keeping child sessions available. Product follow-up determined that this default-closed tree solves the board-clutter problem without a separate visibility filter, so Sessions now always includes recognized children.

Codex child rollout filenames identify only the child. The first `session_meta` line contains the immediate `parent_thread_id`; `payload.session_id` identifies the root but is insufficient for recursive depth-two trees. The immediate parent must therefore be persisted when the daemon discovers a Codex session. Existing persisted Codex metadata can be enriched from discovery without replaying transcripts, changing Kato session identity, advancing cursors, or touching the session activity timestamp.

Activity and workspace filters can match a descendant without matching its parent. The loader must retain nonmatching ancestors as structural context so a matching child remains reachable. Context-only ancestors are not matches and must not inflate page totals.

## Open Issues

- A later slice can lazy-load child row data on expansion. Conditional rendering removes collapsed child rows from the DOM, but the inclusive live API still returns their row data.
- A later provider-specific enrichment can add friendly agent labels. Parentage does not depend on labels or nicknames.

## Decisions

- Recognize Codex sub-conversations only from a valid `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` string.
- Persist the optional immediate `parentProviderSessionId` on session metadata. Old metadata without the field remains valid.
- Backfill existing Codex metadata during discovery using a metadata-only reconciliation; do not mark historical sessions dirty or replay their transcripts.
- Continue deriving Claude sub-conversation parentage from the exact `subagents` source layout, resolving the segment immediately before `subagents` against Claude metadata.
- Resolve provider parent identifiers to Kato session identifiers server-side. Do not expose provider source paths to the browser.
- Render recursive trees because Codex can create children beneath children. Claude relationships remain parent-to-child unless its provider data exposes a deeper deterministic relationship.
- Default all parent disclosures closed. Preserve disclosure state through live polling, and expand ancestor chains for child fragment links.
- Always return and group recognized children on Sessions. Remove separate sub-conversation visibility controls and ignore legacy `subagents` query parameters.
- Retain unmatched ancestors as structural context for activity/workspace matches and exclude those context shells from counts.
- Keep unlinked or malformed children visible in the grouped inventory rather than silently dropping them.
- Keep every row's own persisted Twin size distinct. A collapsed parent may summarize descendant Twin bytes separately.

## Contract Changes

- `SessionMetadataV1` gains optional `parentProviderSessionId` with nonblank-string validation and clone support; schema version 1 remains backward compatible.
- Provider discovery rows can carry an optional immediate parent provider-session id.
- `SessionActivityRow` gains an optional browser-safe sub-conversation relationship resolved to a Kato parent session id plus an optional structural-context marker.
- Sessions page totals count matching real sessions and exclude structural-context ancestors; collapsing does not change totals.
- Sessions query, route, loader, page-data, form, and redirect contracts carry no sub-conversation visibility state; legacy `subagents` query parameters have no effect.

## Testing

- Cover Codex top-level, child, nested-child, and malformed `session_meta` relationship extraction.
- Cover metadata contract validation, cloning, creation, and metadata-only backfill without activity/cursor/twin changes.
- Cover Claude and Codex parent resolution, always-inclusive legacy-query behavior, context-ancestor retention, missing parents, cycles, ordering, and match totals.
- Cover removal of sub-conversation toolbar/form state, collapsed accessible disclosure markup, child badges, Twin values, and nested rendering.
- Cover expansion state surviving live data replacement and child fragment links expanding their ancestor chain.
- Keep Recordings and Maintenance complete and unchanged.

## Non-Goals

- Do not classify relationships from snippets, names, timestamps, file proximity, or provider-session id prefixes.
- Do not invent deeper Claude nesting from workflow directories.
- Do not restore a separate visibility mode; legacy `subagents` query parameters remain ignored.
- Do not hide sub-conversation recordings from Recordings or twins from Maintenance.
- Do not add child lazy-loading or a new detail endpoint in this slice.

## Implementation Plan

- [x] Add substantive provider metadata, backfill, loader relationship, and tree behavior tests.
- [x] Persist and backfill exact Codex immediate-parent metadata and derive exact Claude parents.
- [x] Project filtered tree relationships and structural-context ancestors from the Sessions loader.
- [x] Render recursive, accessible, default-closed Sessions trees with live-poll and deep-link behavior.
- [x] Add responsive tree styling; the short-lived grouped/hidden control was removed by [[task.2026.2026-07-11-session-tree-only-inventory]].
- [x] Update user, developer, decision, testing, feature, and release documentation.
- [x] Run focused validation, formatting, and the full CI gate.
