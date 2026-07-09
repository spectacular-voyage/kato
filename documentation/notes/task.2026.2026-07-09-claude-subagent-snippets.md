---
id: task-2026-07-09-claude-subagent-snippets
title: Claude Subagent Snippets
desc: ""
updated: 1783623089804
created: 1783623089804
---

## Goal

Fix `show snippet` rows that degrade to `snippet unavailable` for Claude workflow/sub-agent transcripts.

## Summary

Claude sub-agent source files live under `subagents/` and are discovered by Kato as separate provider sessions with `agent-*` provider session ids. Those files can contain only sidechain-marked rows. Kato's Claude parser currently skips every `isSidechain: true` row to avoid duplicating sidechain entries inside top-level transcripts, so sub-agent source replay and ingestion can produce zero canonical events and no snippet.

## Discussion

The issue is not necessarily that a later user message is missed. In sub-agent workflows, the initial sub-agent task/prompt may be the only user-authored text useful for a label, and that row is sidechain-marked. The parser should keep skipping sidechains for normal Claude transcript files, but include them when the source file itself is a sub-agent transcript.

## Open Issues

- Should Kato visually label Claude `agent-*` sessions as sub-agents in the Sessions UI later?

## Decisions

- Detect Claude sub-agent source files from a `subagents` path segment.
- Include sidechain events for those source files during live ingestion, source replay, manual persisted-session ingestion, and snippet recovery.
- Preserve the existing default behavior for top-level Claude transcripts.

## Contract Changes

No shared API contract change. This is a provider parser/replay behavior correction for Claude sub-agent source files.

## Testing

- Parser unit coverage for default sidechain skipping and explicit sub-agent sidechain inclusion.
- Provider ingestion coverage for discovered Claude sub-agent transcript snippets.
- Web snippet recovery coverage for a persisted Claude sub-agent metadata row with no live snippet or twin file.

## Non-Goals

- Do not persist snippets in session metadata.
- Do not change the Sessions page privacy model.
- Do not redesign Claude sub-agent inventory visibility.

## Implementation Plan

- [x] Add Claude sub-agent source detection and parser option for sidechain inclusion.
- [x] Use the option from ingestion, source replay, and manual persisted-session ingestion.
- [x] Add focused tests for parser, daemon ingestion, and web snippet reveal.
- [x] Run focused Deno tests.
