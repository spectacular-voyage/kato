---
id: x7ta7m4ble1z6785j71c73f
title: 2026 03 17 Web Commands
desc: ''
updated: 1773783250115
created: 1773763652587
---

## Goal

As a user, I would like to trigger the core workspace-scoped recording controls
from the web client.

## Summary

- From the Sessions page:
  - I would like to be able to trigger "New capture" and "New recording"
    - clicking either action button opens a small workspace-chooser popover
    - the chooser copy explains the difference: "from start" vs
      "moving forward"
    - `New capture` creates a fresh recording file from the full session history and
      keeps that file engaged for future writes
    - `New recording` creates a fresh recording file immediately, including
      frontmatter when enabled, and starts appending conversation content on
      the next event
  - list any engaged recordings for the session in small font, one per line, in
    the form `<workspace alias>: <filename>`
    - workspace alias links to the workspace page
    - filename links to the corresponding recording on the Recordings page
    - each engaged recording includes an inline `[stop]` control
    - the recordings heading includes a `[stop all]` control for the session

## Discussion

- keep this phase focused on Session page command entry, not deeper
  recording/workspace lifecycle management
- in code terms, the persisted field is `desiredState`, while the web activity
  rows currently use `engaged-active` / `engaged-stale` for recordings that are
  still on
- for UI copy, prefer plain-language labels over internal state names:
  `recording`, `ready to record`, and `stopped`

## Open Issues

- none for phase 1

## Decisions

- Leave `Export` out of phase 1
- Leave explicit path entry out of phase 1
- The Sessions page actions are `New capture` and `New recording`
- Both Sessions page actions create a fresh destination path rather than
  reusing the previously engaged workspace output
- `New recording` touches its fresh destination immediately so the new file is
  visible before the next conversation event arrives
- Existing engaged recordings are listed on the Sessions page, but not directly
  controlled there except for stop controls
- Stop controls on the Sessions page only apply to engaged recordings
- Keep internal state naming as-is, but map UI labels as:
  `engaged-active` -> `recording`
  `engaged-stale` -> `ready to record`
  `stopped` -> `stopped`
- Recording deep links use `recordingCycleId` when present, with a stable
  hashed row-key fallback for synthesized rows

## Contract Changes

- likely new web mutation surface for Session page `New capture` / `New
  recording` controls
- new web mutation surface for Session page `stop-recording` / `stop-all-recordings`
  controls
- Sessions page data/rendering will need engaged recording summary rows with
  workspace and recording links
- Sessions page engaged recording rows include inline stop controls and a
  stop-all heading control
- UI copy for recording state should use the operator-facing labels above,
  rather than exposing `engaged-*` terminology directly
- The Recordings page uses stable anchors so filename links can target a
  specific recording row

## Testing

- route/loader tests for `New capture` / `New recording` mutations and the
  resulting engaged recording list state
- mutation tests for per-recording stop and stop-all behavior on engaged
  recordings
- rendering tests should confirm the UI labels `recording`, `ready to record`,
  and `stopped` instead of internal `engaged-*` terms
- manual smoke check for selector, workspace link, and recording link flows

## Non-Goals

- `Export` and explicit path entry in phase 1
- Recording-row lifecycle controls on the Recordings page
- Resume/start controls or other direct manipulation of stopped recordings on
  the Sessions page
- Workspace display names, alias editing, and per-workspace settings editing
- Maintenance-page twin-generation controls
- Summary-page workspace labeling polish
- These move to `task.2026.2026-03-17-web-commands-phase2`

## Implementation Plan

- [x] Define the mutation surface for Session page `New capture` / `New
      recording` controls
- [x] Define how engaged recordings are rendered and linked from the Sessions
      page
- [x] Implement the UI and route wiring
- [x] Add per-recording stop and session-level stop-all controls on the
      Sessions page
- [x] Add tests for the new mutation, linking, and loader behavior
- [x] Do a manual browser smoke pass for selector and deep-link flows

## Coderabbit suggestions

Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@apps/web/islands/SessionsLive.tsx`:
- [x] Around line 153-160: The popover create actions for "new-capture" and
"new-recording" are not latched so rapid double-clicks can submit twice; add a
submission latch (e.g., a boolean submitting state) and check it in the submit
handlers to ignore subsequent clicks until the first request resolves, or
disable the submit button while submitting; update the handlers that currently
call the create actions (those that use openAction / setOpenAction and the
workspace selection state selectedWorkspace / setSelectedWorkspace) to set the
latch at start, await the create call, then clear the latch and close the
popover (setOpenAction(null)) only after success/failure, and apply the same
change to the other submit handlers referenced around the 240-279 range so both
new-capture and new-recording cannot be double-submitted.
- [x] Around line 248-266: The workspace <select> in SessionsLive.tsx is missing an
accessible name; update the JSX to associate the visible title (from
buildPopoverTitle(openAction)) with the select by either adding a <label> that
references the select or setting aria-labelledby to the id of the title element.
Concretely, give the title element a stable id (e.g.,
"workspace-popover-title-<openAction>"/unique id) where
buildPopoverTitle(openAction) is rendered and add aria-labelledby="that-id" to
the <select> (or wrap the select with a <label> whose htmlFor matches the
select's id). Ensure this change keeps selectedWorkspace, setSelectedWorkspace,
and props.workspaceOptions usage intact.
- [x] Around line 74-76: The canStopRecording function currently only checks
workspaceId so rows without a recordingCycleId still render a Stop control and
submit an empty recordingCycleId; update canStopRecording(recording:
SessionRecordingActivityRow) to require a truthy recording.recordingCycleId (in
addition to workspaceId) and update any other rendering checks that gate the
Stop form (the same conditional used around the Stop button/stop form, noted
near the other instance at lines ~543-548) to use this stricter predicate so the
Stop button is only shown when recording.recordingCycleId is present.

In `@apps/web/src/session_recording_actions.ts`:
- [x] Around line 523-530: The new-recording branch inconsistently uses two resolver
calls causing mismatched output dir values; unify by using the resolver-returned
value (resolved.resolvedDefaultOutputDir or the local resolvedDefaultOutputDir
returned from resolveWorkspaceDefaultOutputDir) everywhere in the new-recording
flow: replace the separate resolveWorkspaceDefaultOutputDir(now()) snapshot
usage with the already computed resolved.resolvedDefaultOutputDir (or the local
resolvedDefaultOutputDir variable that was created with
resolveWorkspaceDefaultOutputDir({ profile, provider: metadata.provider,
sessionId: metadata.providerSessionId, now: now(), outputUsername,
boundarySnapshot: history.events })) so the output snapshot and binding remain
consistent across date/rotation boundaries.
- [x] Around line 389-414: This code performs a read→mutate→save on the same session
metadata without synchronization; wrap the entire stop logic (the branch using
readWorkspaceOutputs, stopAllWorkspaceOutputs, findActiveWorkspaceOutputForStop,
closeWorkspaceOutputCycle and the subsequent sessionStore.saveSessionMetadata
call that uses metadata, writeCursor and nowIso) in a per-session critical
section so mutations are serialized. Use the existing session identifier on
metadata to acquire a session-scoped lock or call a sessionStore-provided atomic
helper (or implement a lightweight mutex keyed by metadata.sessionId) before
reading/mutating and release it only after saveSessionMetadata completes; apply
the same pattern to the other ranges noted (lines 559-593, 611-652) to prevent
concurrent start/stop races and out-of-sync persisted state and files.


---

Nitpick comments:
In `@apps/web/src/log_results.tsx`:
- [c] Around line 10-29: The relativeTimestamp function duplicates logic from
formatRelativeTimestamp in time.ts; replace the body of relativeTimestamp to
call formatRelativeTimestamp and pass the current time (Date.now()) as the nowMs
argument so there is a single source of truth. Specifically, update
relativeTimestamp to import/require formatRelativeTimestamp and return
formatRelativeTimestamp(value, Date.now()), removing the duplicated computation
and keeping the same return behavior.
