---
id: 20260709-workspace-auto-recording
title: Workspace Auto Recording
desc: ""
updated: 1783625477187
created: 1783625477187
---

## Goal

Automatically start workspace-scoped recordings for conversations that can be confidently associated with a registered workspace.

## Summary

Add an opt-in per-workspace config setting for automatic recording. The first provider implementation should be Claude-only, using the `cwd` emitted in Claude user entries as the workspace match signal. When a Claude session's working directory is inside a registered workspace with auto-recording enabled, the daemon should create the same persisted workspace output state used by manual `::record-<alias>` and append future events to the generated workspace destination.

## Discussion

Manual recording already persists workspace outputs on session metadata and appends pending events through the daemon runtime loop. Auto-recording should reuse that path instead of introducing a parallel writer.

Workspace matching must be conservative. Provider transcript files usually live under provider-owned directories, so source file containment is not a reliable workspace signal. Claude user entries include `cwd`; this can be matched against registered workspace roots. Codex also has some `session_meta.cwd` shape in fixtures, but live reliability is uncertain enough that the first implementation should not auto-record Codex.

## Open Issues

- Should Codex opt in later using `session_meta.cwd`, or should it wait for a stronger provider-level project root contract?
- Should auto-recording ever do a bulk migration over old, inactive provider sessions?

## Decisions

- Add `autoRecordConversations` as a workspace config setting with a default of `false`.
- Implement automatic matching for Claude only in this task.
- Use the existing workspace filename template/default output dir path resolution.
- Do not let auto-recording override an existing workspace output for the same session.
- When a session is first auto-attached, append the loaded snapshot from cursor 0 so the generated recording starts with the conversation context Kato has available.

## Contract Changes

- `.kato-workspace-config.yaml` supports top-level `autoRecordConversations: boolean`.
- Resolved workspace config/profile values expose `autoRecordConversations`.
- Claude parsed events may include `source.workingDirectory` when the provider entry carries `cwd`.
- Session metadata may persist `workingDirectory` as the daemon's inferred provider session working directory.

## Testing

- Workspace config parsing, serialization, scaffold, and mutation coverage for `autoRecordConversations`.
- Claude parser coverage for `source.workingDirectory`.
- Daemon runtime coverage proving a Claude session with matching workspace `cwd` auto-creates an active workspace output and appends events.
- Daemon runtime coverage proving non-Claude sessions are not auto-recorded by this feature.

## Non-Goals

- No provider-wide auto-recording without workspace matching.
- No Codex or Gemini auto-recording in this first pass.
- No bulk migration over old, inactive provider sessions.

## Implementation Plan

- [x] Add workspace config contract, defaults, scaffold, and web editing support.
- [x] Add Claude working-directory extraction and session metadata persistence.
- [x] Add persistent daemon auto-recording attachment before append processing.
- [x] Add focused tests for config, Claude parsing, and daemon behavior.
- [x] Update user/developer documentation.
