---
id: task-2026-07-11-session-tree-only-inventory
title: Session Tree Only Inventory
desc: Remove the redundant sub-conversation visibility filter and address follow-up review findings.
updated: 1783806904000
created: 1783806904000
---

## Goal

Make the default-closed parent/sub-conversation tree the only Sessions presentation, remove the redundant Grouped/Hidden filter end to end, and address the still-valid follow-up CodeRabbit findings without regressing title/filename customization or parent metadata reconciliation.

## Summary

Collapsed parent trees make sub-conversations unobtrusive while preserving access to their activity, recordings, and Twin history. The separate hidden-sub-conversation inventory mode now adds controls, query state, loader branches, redirect state, tests, and documentation without enough product value. Sessions should always return and group recognized children. Legacy `subagents=hide` query parameters are ignored rather than rejected.

The follow-up review also identifies a real raw-versus-trimmed comparison bug in parent metadata reconciliation and a maintainability issue in the Sessions query wrapper. The reported Sessions title/slug synchronization issue must be checked against the newer independent customization-state implementation before changing it.

## Discussion

Removing the filter must not remove provider relationship classification, ancestor context retention, recursive tree rendering, the unlinked-child fallback, or complete Recordings and Maintenance inventories. Literal Claude `subagents` source paths remain provider contracts and are unrelated to the removed URL/UI filter.

## Open Issues

- None. The user explicitly prefers the always-grouped tree and requested removal of the visibility control.

## Decisions

- Sessions always includes recognized top-level and child sessions and renders children in default-closed recursive trees.
- Remove `includeSubagents` from web-local query, route, loader, page-data, island, form, and redirect contracts.
- Ignore legacy `subagents` query parameters through the ordinary base Sessions query parser.
- Preserve activity and workspace filtering, including uncounted structural ancestors for matching children.
- Normalize optional provider parent ids before initial persistence and derive reconciliation results from whether reconciliation returned a new metadata object.
- Do not change the current title/slug effect unless the review finding reproduces against its independent field-state helper.

## Contract Changes

- `/sessions` and `/api/sessions` no longer implement `subagents=hide`; legacy parameters have no effect.
- `SessionsPageData`, `LoadSessionActivityRowsOptions`, `SessionRouteOptions`, and Sessions action forms no longer carry `includeSubagents`.
- Parent reconciliation reports `updated` only when metadata was actually changed and written; blank or normalized-equal parent strings report `unchanged`.
- Initial optional parent ids are trimmed, with blank values omitted.

## Testing

- Prove legacy `subagents=hide` URLs return the same rows, totals, and query projection as the ordinary grouped Sessions inventory.
- Keep Claude/Codex relationship, recursive tree, unlinked group, and filtered-ancestor coverage.
- Prove Sessions toolbar/action markup no longer emits sub-conversation controls or hidden state.
- Cover exact, padded-equal, blank, padded-different, and missing-session parent reconciliation plus normalized initial creation.
- Re-run title/slug state tests to verify reset behavior before deciding whether that CodeRabbit finding remains valid.
- Run focused tests, checks, and the full CI gate.

## Review Finding Dispositions

- Parent reconciliation: valid. Initial and reconciled parent provider-session ids are normalized consistently, and reconciliation now reports `updated` only when it returns and caches changed metadata.
- Sessions title/slug synchronization: already fixed by the independent display-title and filename-slug customization state. The reset path preserves an edited title while restoring only the derived/inherited slug, so no additional production change was needed.
- Sessions query spread: superseded by removal of the visibility feature. The specialized Sessions wrapper no longer has an override to preserve and was deleted in favor of `parseSessionPageQuery` directly.

## Non-Goals

- Do not remove child-session discovery, persisted Codex parent metadata, Claude parent resolution, or recursive tree UI.
- Do not hide sub-conversation recordings or Twin maintenance rows.
- Do not reply to or resolve GitHub review threads without explicit authorization.

## Implementation Plan

- [x] Audit the filter dependency graph and all three review findings against current code.
- [x] Remove Grouped/Hidden query, loader, route, form, and toolbar state.
- [x] Preserve always-inclusive tree, filtered-ancestor, and deep-link behavior.
- [x] Fix normalized parent creation/reconciliation and add regression tests.
- [x] Update release, user, developer, decision, testing, and historical task documentation.
- [x] Run focused validation and the full CI gate.
