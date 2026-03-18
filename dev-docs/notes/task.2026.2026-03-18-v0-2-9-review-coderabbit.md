---
id: 3n9iaw5m5tf3nuim7fcjmeu
title: 2026 03 18 V0 2 9 Review Coderabbit
desc: ""
updated: 1773862637970
created: 1773859198247
---

## Coderabbit comments

Verify each finding against the current code and only fix it if needed.

Current triage: 4 follow-ups are complete, 1 comment is a Dendron false
positive and should stay cancelled.

Inline comments:
In `@apps/runtime/src/workspace/registry.ts`:

- [x] Around line 94-95: The workspace equality checks in registry.ts currently
      ignore the new displayName field, so comparisons that determine "unchanged"
      snapshots can drop updates that only change displayName; update the
      comparator(s) that compare workspace objects (the functions/blocks that
      currently compare workspaceRoot and other fields) to include the displayName
      property in their equality checks (in the three comparator sites noted in this
      file), ensuring displayName is considered alongside workspaceRoot when deciding
      if a workspace is unchanged.

In `@dev-docs/notes/dev.release-runbook.md`:

- [c] Line 5: Remove the manual frontmatter timestamp edit by deleting or reverting
  the "updated: 1773788589359" line in dev-docs/notes/dev.release-runbook.md so
  the Dendron-managed 'updated' field is not modified by hand; ensure the file's
  frontmatter contains no manually-set 'updated' key and let Dendron populate it
  automatically. Dendron notes in this vault intentionally keep an `updated`
  frontmatter field; the rule is to avoid hand-editing it, not to remove it.

---

Outside diff comments:
In `@apps/web/src/loaders/sessions.ts`:

- [x] Around line 620-645: Tighten alias-only live recording fallback so rows
      without `workspaceId` still resolve workspace display names from alias-based
      registry metadata and continue to match workspace filters when only
      `workspaceAlias` is available.

---

Nitpick comments:
In `@apps/cli/src/usage.ts`:

- [x] Around line 95-101: Update the usage synopsis string for the "kato workspace
      register" command to include the explicit form name=<display-name> (matching the
      later explanatory line) so users can discover that syntax; locate the usage text
      in apps/cli/src/usage.ts (the string that starts with "Usage: kato workspace
      register ...") and change the --name token in the top-line synopsis to show
      name=<display-name> (or include both forms) so it matches the documented example
      on the later line.

In `@apps/web/src/loaders/sessions.ts`:

- [x] Around line 599-605: The page assembly reads the workspace registry multiple
      times causing extra I/O and potential inconsistent results; modify the code so a
      single registry snapshot (the result of loadRegisteredWorkspaces/katoDir
      currently assigned to workspaceEntries or the variable snapshot) is read once
      and reused: change callers so loadSessionActivityRows() accepts the
      already-loaded registry snapshot (or pass workspaceEntries) and remove the
      second loadRegisteredWorkspaces() call in loadSessionsPageData(), and similarly
      replace the duplicate read at the other location (around the 712-719 block) to
      use the same snapshot variable (workspaceEntries/snapshot) so both filter
      metadata and workspaceOptions come from the identical in-memory snapshot.

## Round 2

Verify each finding against the current code and only fix it if needed.

Current triage: 7 follow-ups look actionable, 2 comments should stay
cancelled (1 duplicate of the handler-level CSRF fix, 1 conflicts with the
explicit `lastWriteAt` decision in
[[task.2026.2026-03-18-persist-recording-last-write]]).

In `@apps/daemon/src/orchestrator/daemon_runtime.ts`:
- [x] Around line 2072-2088: mergeWorkspaceOutputsPreferringLatest currently skips
adding a matching `current` entry (by buildWorkspaceOutputMergeKey) which
discards fields like a newer `writeCursor`/`lastWriteAt`; change it so matching
entries are merged instead of dropped: when a key collision is found, locate the
existing merged entry and update/merge its properties with values from `current`
(e.g., override or take the newest/non-undefined `writeCursor`, `lastWriteAt`,
and other mutable metadata) while keeping other fields from `latest`; use
structuredClone where needed and continue using buildWorkspaceOutputMergeKey for
matching; apply the same merging logic to the duplicate implementation
referenced around processPersistentRecordingUpdates.

In `@apps/web/routes/recordings.tsx`:
- [c] Around line 21-25: The POST route currently calls
handleRecordingsPagePost(ctx.req) which prevents CSRF validation because
ctx.state.csrfToken isn’t available; either pass the full context to
handleRecordingsPagePost (call handleRecordingsPagePost(ctx)) and validate
req.formData() against ctx.state.csrfToken inside that function, or validate the
CSRF token here in the route handler by reading FormData from ctx.req, comparing
it to ctx.state.csrfToken, then calling handleRecordingsPagePost with the
already-parsed FormData (update handleRecordingsPagePost signature to accept
FormData to avoid re-reading the body). This overlaps the more concrete
handler-level CSRF item below, so we should carry the work there instead of
tracking both.

In `@apps/web/src/loaders/sessions.ts`:
- [ ] Around line 372-374: The code currently prefers liveRecording timestamps over
persisted cycle timestamps which can regress fresh data; update the precedence
so persisted cycle timestamps win: in loadSessionActivityRows() change
activeLastWriteAt (and any similar assignments at the other locations
referenced) to use activeCycle?.lastWriteAt ?? liveRecording?.lastWriteAt
instead of the reverse, and ensure activeStartedAt/other startedAt assignments
likewise prefer activeCycle values when present; apply the same swap for the
other occurrences (lines referenced around 471-473, 512-517, 524-525, 575-580)
so workspaceOutputs/sessionStore.listSessionMetadata() persisted values take
precedence over heartbeat snapshot values.

In `@apps/web/src/recordings_page_post.ts`:
- [x] Around line 149-156: The redirect currently embeds raw exception text via the
error query param in Response.redirect(buildRedirectUrl(..., { error: error
instanceof Error ? error.message : String(error) })), which can leak filesystem
paths; instead, remove the raw error from the URL and replace it with a short
safe token (e.g. "restart_failed" or "internal_error") when calling
buildRedirectUrl, and log the full error server-side using the existing logger
(or console.error) inside the same POST handler so details are retained in
server logs but not reflected to the client; update the code paths around
buildRedirectUrl/Response.redirect in recordings_page_post.ts to implement this
change.
- [x] Around line 66-80: The handler handleRecordingsPagePost currently reads form
fields but never validates the submitted csrfToken; extract csrfToken from the
form (e.g. const csrfToken = String(form.get("csrfToken") ?? "")) and call your
CSRF validation utility (e.g. verifyCsrfToken or validateCsrfToken from your
auth/csrf module) before creating loggers or dispatching any recording
mutations; if validation fails, return an HTTP 403/401 response immediately and
do not proceed with createWebLoggers or any state changes so the cross-site POST
cannot start/stop recordings.

In `@apps/web/src/session_recording_actions.ts`:
- [x] Around line 464-507: stopConflictingActiveOutputsAtPath currently persists
changes to other sessions immediately (via sessionStore.saveSessionMetadata)
which can leave unrelated recordings stopped if the target session mutation
later fails; instead change stopConflictingActiveOutputsAtPath to only compute
and return the modified metadata objects (or a list of {metadata, changed} and
stoppedCount) without calling sessionStore.saveSessionMetadata, and move the
actual persistence call into the caller after the target mutation (the caller
that runs appendToDestination / saveSessionMetadata on the target should apply
the saved changes to other sessions only on success). Update references to
readWorkspaceOutputs, closeWorkspaceOutputCycle and
sessionStore.saveSessionMetadata accordingly so the helper no longer persists
and callers perform the saves (or perform rollback) after the target commit.

In `@tests/daemon-runtime_test.ts`:
- [x] Around line 6523-6536: The test mock must be pinned to a stale metadata
instance so loadLatestSessionMetadataForMerge() (which only calls
listSessionMetadata()) exercises the stale-merge path; change the
getOrCreateSessionMetadata() implementation to return a structuredClone of the
original staleMetadata (not the mutable storedMetadata) and keep
listSessionMetadata() behavior that flips storedMetadata to webMutated on the
first call (using metadataReads). This ensures getOrCreateSessionMetadata()
always yields the stale snapshot while listSessionMetadata() can still simulate
a later web update for merge/save testing; reference listSessionMetadata,
getOrCreateSessionMetadata, storedMetadata, and webMutatedMetadata when making
the change.

---

Outside diff comments:
In `@apps/daemon/src/orchestrator/runtime_workspace_output_state.ts`:
- [c] Around line 100-105: The new recording cycle is being seeded with lastWriteAt
which incorrectly marks a fresh/armed cycle as recently written; remove the
lastWriteAt (and any pre-populated value like nowIso) from the object pushed
into recordingCycles in runtime_workspace_output_state.ts so that lastWriteAt is
only set by updateWorkspaceOutputCycleLastWrite() after a successful write; keep
startedAt/restartedAt as the source of "armed since" information and ensure any
tests/consumers expect lastWriteAt to be absent/null until
updateWorkspaceOutputCycleLastWrite() runs. This conflicts with the explicit
decision in [[task.2026.2026-03-18-persist-recording-last-write]] to initialize
`lastWriteAt` when a cycle opens so persisted recency matches current live
recording semantics.

---

Nitpick comments:
In `@apps/web/tests/recordings_live_test.tsx`:
- [ ] Around line 104-114: The assertions use indexOf over the whole HTML which can
pass even if other rows are out of order; scope the check to a single recording
row by first locating that row element (e.g., find a row/container node by a
unique selector or by using a known marker in the test HTML), then extract its
innerHTML or text and compute fileIndex/startedIndex/workspaceIndex/sessionIndex
from that sliced string before asserting their ordering; update the variables
referenced (fileIndex, startedIndex, workspaceIndex, sessionIndex) in
recordings_live_test.tsx to operate on the row-specific string or parsed DOM
node instead of the full html variable.
