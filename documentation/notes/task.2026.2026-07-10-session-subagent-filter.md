---
id: task-2026-07-10-session-subagent-filter
title: Session Subagent Filter
desc: ""
updated: 1783718400000
created: 1783718400000
---

## Goal

Keep the Kato Web Sessions inventory usable when Claude workflows discover many sub-agent transcripts by adding a top-level filter that can exclude sub-agent conversations.

## Summary

Claude sub-agent sessions are already identified during parsing by an exact `subagents` source-path segment. The Sessions loader has access to persisted `sourceFilePath`, so it can reuse that provider-aware classification without exposing local paths to the browser or guessing from an `agent-*` provider-session id.

This is the inventory-visibility follow-up deferred by [[task.2026.2026-07-09-claude-subagent-snippets]].

## Discussion

The Sessions page already uses URL-driven activity and workspace filters, and its live API polls the same query. Sub-agent visibility should follow that model so server rendering, polling, refreshes, bookmarks, and post/redirect/get recording actions agree on the visible inventory.

Filtering should happen before the Sessions page totals are calculated. Counts and the empty state will therefore describe the visible rows, not hidden sub-agent sessions. Unknown or unrecognized provider-session layouts must remain visible rather than being hidden by a heuristic.

## Open Issues

- Should the Sessions page eventually remember the selected sub-agent visibility across visits without requiring a bookmarked URL?
- Should visible sub-agent rows gain an explicit badge or parent-session relationship after the basic inventory filter has soaked?

## Decisions

- Classify a row as a sub-agent only when its provider is Claude and its persisted source path matches the existing exact-segment `subagents` rule.
- Do not classify from an `agent-*` provider-session id alone.
- Keep the default Sessions inventory inclusive for compatibility. The opt-in `Top-level only` filter excludes classified sub-agent sessions.
- Represent the non-default filter as `subagents=hide`; missing or unrecognized query values remain inclusive.
- Compose sub-agent visibility with activity and workspace filters, and preserve it through Sessions links, live polling, and recording-action redirects.
- Scope the filter to the Sessions inventory. Recordings and Maintenance remain complete operational inventories.

## Contract Changes

- Add `includeSubagents` to the internal Sessions query, route, loader, and page-data contracts.
- `/api/sessions` accepts the same `subagents=hide` query as `/sessions` and returns filtered rows and totals when selected.
- No shared persisted-session or provider contract changes are required; classification is derived from existing session metadata.

## Testing

- Cover default, recognized, and unrecognized query values.
- Cover href composition with activity, workspace, and sub-agent filters.
- Cover provider-aware loader classification, including Windows path separators and a deceptive non-Claude or top-level `agent-*` id.
- Cover filtered rows and totals from the live Sessions API.
- Cover Sessions toolbar rendering and hidden form fields so recording actions preserve the selected filter.

## Non-Goals

- Do not hide sub-agent recordings from Recordings or persisted twins from Maintenance.
- Do not add parent/child session relationships.
- Do not infer sub-agent status for providers whose source layout has no explicit supported rule.
- Do not add a sub-agent badge or redesign session rows in this slice.

## Implementation Plan

- [x] Add focused query, route, loader, API, and toolbar contract tests.
- [x] Add provider-aware Sessions filtering and filtered totals.
- [x] Preserve the filter through links, polling, and recording-action redirects.
- [x] Update user, developer, decision, testing, and release documentation.
- [x] Run focused tests, formatting, lint, and type checks.
