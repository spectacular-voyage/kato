---
id: task-2026-07-28-workspaces-read-view-auto-record
title: Workspaces Read View Auto-Record Visibility
desc: Show each workspace's resolved auto-record state on the /workspaces list without opening the edit form.
updated: 1785266853000
created: 1785265932657
---

## Goal

Make the `/workspaces` page show whether auto-recording is enabled for each workspace without opening the edit form.

## Summary

`autoRecordConversations` is currently rendered in exactly one place: the edit form checkbox (`apps/web/routes/workspaces/[workspaceId]/edit.tsx`). The `/workspaces` rows (`apps/web/islands/WorkspacesLive.tsx` fed by `apps/web/src/loaders/workspaces.ts`) show label, id, root, config validity, write-root coverage, username, wikilink diagnostics, and recordings — but `WorkspaceManagementRow` does not carry the auto-record field, so an operator cannot tell whether auto-record is on without entering edit mode. (`/workspaces` is not read-only — it already unregisters and edits labels/usernames — but the edit form is the only auto-record write surface, and stays that way.)

## Discussion

The row shows the resolved value (what the daemon would use), not the raw file override, mirroring the edit form's binding to effective values. Resolution reuses `WorkspaceProfileResolver.resolveForCommand` — the same resolver the daemon uses — not a second partial resolution path; the loader currently reloads raw overrides only for wikilink diagnostics (`workspaces.ts:152`) and the edit loader resolves separately (`workspace_config_edit.ts:177`), and this task must not add a third variant. When resolution fails (invalid config), the indicator reads "unavailable", never "off"; the row's existing config-invalid marker explains why.

This slice is strictly the resolved boolean: on / off / unavailable. Auto-record health (roots, last activation, last failure from daemon status) and `autoRecordSubconversations`/`autoRecordRoots` display are follow-up work dependent on [[task.2026.2026-07-28-auto-record-conversation-roots]] and [[task.2026.2026-07-12-auto-record-subconversation-scope]] landing their typed fields; nothing here renders conditionally on their landing order. No daemon changes.

Compatibility: workspace configs without the key resolve to `false` (rendered "off"); config resolution failing renders "unavailable". Both fall out of the resolver defaults — no migration.

## Open Issues

- None.

## Decisions

- Surface the resolved `autoRecordConversations` boolean on each `/workspaces` row as an "auto-record: on/off" line, "auto-record: unavailable" when resolution fails.
- Resolve via `WorkspaceProfileResolver.resolveForCommand`; no partial re-resolution.
- Strictly boolean slice; health and additional auto-record settings display are follow-ups on the other tasks' typed contracts.
- The edit form remains the only auto-record config write surface.

## Contract Changes

- `WorkspaceManagementRow` gains `autoRecordConversations?: boolean` (undefined = unavailable); the workspaces loader populates it via the shared resolver.
- `WorkspacesLive` renders the indicator; no new POST actions; API JSON for the workspaces page carries the field.

## Testing

- Loader: resolved `true`, resolved `false` (key absent and explicit false both render "off"), unavailable for invalid config and for resolver errors, missing config file, JSON serialization of the field.
- Island render: on, off, and unavailable states asserted by accessible text (not class names only).
- Run focused web tests and the production web build.

## Non-Goals

- No editing from the read view.
- No new read-only workspace detail page.
- No daemon or status-schema changes; no health display in this slice.
- No display of `autoRecordRoots`/`autoRecordSubconversations` until their tasks land typed fields.

## Implementation Plan

- [x] Add `autoRecordConversations` to the workspaces loader via `WorkspaceProfileResolver.resolveForCommand` and to `WorkspaceManagementRow`.
- [x] Render the on/off/unavailable indicator in `WorkspacesLive`.
- [x] Tests per the Testing section.
- [x] Update [[user-guide.workspaces]] (release notes at next `bump:version`).
- [x] Run focused validation and the production web build.
