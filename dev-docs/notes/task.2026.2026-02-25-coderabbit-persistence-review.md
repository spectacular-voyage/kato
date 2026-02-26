---
id: 6pmb02qfq64qkypl9wbw1wz
title: 2026 02 25 Coderabbit Persistence Review
desc: ''
updated: 1772091896178
created: 1772090825327
---

Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@apps/daemon/src/cli/commands/start.ts`:
- [x] Around line 23-35: The polling loop should tolerate transient read errors from
ctx.statusStore.load instead of aborting; wrap the call to
ctx.statusStore.load() inside a try-catch within the while loop (the loop that
checks Date.now() < deadline and uses launchedPid/launchedAtMs and
STARTUP_ACK_POLL_INTERVAL_MS), and on caught errors (except you may still allow
NotFound to be handled as before) treat them as transient: optionally log/debug
the error and continue to the next poll without throwing, letting the loop retry
until deadline; ensure the function still returns the heartbeat info when
conditions are met and still awaits sleep(STARTUP_ACK_POLL_INTERVAL_MS) between
retries.

In `@apps/daemon/src/orchestrator/control_plane.ts`:
- [x] Around line 250-258: The env overrides for KATO_DAEMON_STATUS_PATH and
KATO_DAEMON_CONTROL_PATH in resolveDefaultStatusPath and
resolveDefaultControlPath bypass expandHomePath, so update these functions to
run expandHomePath on the value returned by readOptionalEnv before falling back
to join(runtimeDir, ...); i.e., if readOptionalEnv(...) returns a value, pass it
through expandHomePath to correctly expand leading "~" (use the same
expandHomePath helper used for KATO_RUNTIME_DIR).

In `@apps/daemon/src/orchestrator/daemon_runtime.ts`:
- [x] Around line 519-537: The code currently adds a recording to metadata
(metadata.recordings push, openRecordingPeriod) when canonicalCommand ===
"start" before validating the destination path; move or add a pre-check that
validates the destination/path-policy (reuse the existing path-validation
routine used elsewhere or call the same validator used in the append loop) and
only mutate metadata (creating recordingId, pushing to metadata.recordings,
calling openRecordingPeriod, setting metadataChanged) after the destination is
confirmed allowed; update the start-handling branch that uses canonicalCommand,
recordingId, metadata.recordings, and openRecordingPeriod so validation runs
first and any validation failure returns an error immediately without altering
metadata.
- [x] Around line 585-611: The success log "recording.command.applied" is emitted
even when applyPersistentStopCommand(...) returns false, which is misleading;
change the logic so the operationalLogger.info call for the stop path is only
executed when the stop actually changed state (i.e., when the local variable
stopped is true). Locate the branch where canonicalCommand === "stop" and
applyPersistentStopCommand(...) is awaited, and wrap or gate the
operationalLogger.info invocation (or emit an alternative log) behind a check of
stopped (and keep metadataChanged = metadataChanged || stopped as-is).

In `@apps/daemon/src/orchestrator/session_twin_mapper.ts`:
- [c] Around line 329-343: In the reverse conversion loop in session_twin_mapper.ts,
replace the incorrect session mapping that sets sessionId from
event.session.providerSessionId with event.session.sessionId so the
reconstructed ConversationEvent.sessionId matches the original; locate the loop
that builds the common object (referencing makeEventId and the forward mapping
in makeBaseDraft) and change the sessionId assignment to use
event.session.sessionId to ensure round-trip consistency.

In `@apps/daemon/src/utils/hash.ts`:
- [x] Around line 12-26: stableStringify currently uses JSON.stringify on undefined
which can return undefined (violating the string return type) and lets undefined
become the literal "undefined" when interpolated into object serialization;
update stableStringify to explicitly handle undefined values by returning a
string (e.g., "null" or a defined token per project semantics) and when
serializing records (isRecordValue) filter out keys with undefined values before
mapping keys, ensuring the function always returns a string; locate and modify
the branches in stableStringify (primitive branch checking typeof value,
Array.isArray branch, and the isRecordValue branch) so undefined is handled
up-front and object key iteration uses the filtered keys array.


In `@tests/session-state-store_test.ts`:
- [x] Around line 90-95: The test currently corrupts daemon-control.json then calls
store.loadDaemonControlIndex() on the same PersistentSessionStateStore instance,
which can return a cached in-memory index and bypass rebuild verification;
update the test to force a cold load by creating a fresh
PersistentSessionStateStore (or otherwise clearing its cache) before calling
loadDaemonControlIndex() so the call actually reads from disk and validates
rebuild-from-disk behavior (reference the PersistentSessionStateStore
constructor and loadDaemonControlIndex method / the test variable store).

---

Nitpick comments:
In `@apps/daemon/src/cli/commands/clean.ts`:
- [x] Around line 152-168: The loop currently treats any deletion error other than
Deno.errors.NotFound as a "missing file" by setting sessionFailed and later
adding to stats.missingFiles; change this by adding a separate counter (e.g.,
deletionFailures) and increment it when a deletion throws a non-NotFound error
(within the try/catch where sessionFailed is set), then when sessionFailed is
true add the computed number to stats.deletionFailures instead of
stats.missingFiles; keep the existing behavior for NotFound errors so
stats.missingFiles still reflects only files that truly do not exist.
- [x] Around line 86-88: The current use of const mtimeMs = stat.mtime?.getTime() ??
0 will treat missing mtime as epoch 0 and can cause unintended deletions; change
the logic in the clean command where stat and mtimeMs are used (the block
immediately after the try/catch that throws error and computes mtimeMs) to
defensively handle a null/undefined stat.mtime by skipping that file (or logging
and continuing) instead of defaulting to 0—check stat.mtime explicitly, if
absent log/debug the path and continue to next item, otherwise compute mtimeMs
with stat.mtime.getTime() and proceed with the age check.

In `@apps/daemon/src/cli/commands/status.ts`:
- [x] Around line 32-34: The sessionIdentity construction uses s.sessionId in the
else branch causing inconsistent output; update the else branch in the code that
builds sessionIdentity so it uses s.sessionShortId ?? s.sessionId (matching the
ternary branch that includes providerSessionId) — modify the expression that
currently produces `${s.provider}/${s.sessionId}` to
`${s.provider}/${s.sessionShortId ?? s.sessionId}` so both branches display the
short ID when available.

In `@apps/daemon/src/orchestrator/provider_ingestion.ts`:
- [x] Around line 582-591: The function currently returns undefined when the parsed
file is invalid but returns an empty array when parsed["messages"] exists but is
not an array; make the return values consistent by returning undefined for all
error/invalid cases (replace the "return []" branch with "return undefined") so
callers get the same signal for unreadable/invalid input; update any type
annotations or callers of this function that expect an array to handle undefined
accordingly and ensure references to parsed, messages, and isRecordValue remain
intact.
- [c] Around line 1361-1445: Extract the snapshot hydration block guarded by
shouldHydrateSnapshot into a new method (e.g., hydrateSessionSnapshot) on the
class to reduce nesting and improve testability; move logic that checks
shouldAppendTwin, handles existingSnapshotEvents vs. rebuilt twin events (calls
to this.sessionStateStore.readTwinEvents and mapTwinEventsToConversation),
merging (mergeEvents), logging (this.operationalLogger.debug), and finally
calling this.sessionSnapshotStore.upsert into that method, and replace the large
inline block with a single call to this.hydrateSessionSnapshot({
currentSnapshot, incomingEvents, appendedTwinEvents, latestCursor,
fileModifiedAtMs, stateMetadata, sessionId }); ensure the new method preserves
all existing behaviors, uses the same unique symbols (shouldAppendTwin,
mapTwinEventsToConversation, mergeEvents, sessionStateStore.readTwinEvents,
sessionSnapshotStore.upsert, operationalLogger) and returns/throws the same
errors so callers unchanged.

In `@apps/daemon/src/orchestrator/session_state_store.ts`:
- [x] Around line 95-100: The cloneCursor function contains an unnecessary branch
for the "opaque" kind; simplify cloneCursor by removing the conditional and
always returning a new object with the cursor's kind and value (i.e., return {
kind: cursor.kind, value: cursor.value }), keeping the function name cloneCursor
and the ProviderCursor shape unchanged.
- [x] Around line 167-183: The writeTextAtomically function currently leaves the
temporary file (tmpPath) if Deno.rename(path) fails; wrap the final
Deno.rename(tmpPath, path) call in a try-catch, and in the catch attempt to
Deno.remove(tmpPath) (or unlink) to clean up the temp file, then rethrow the
original error so callers still see the failure; ensure tmpPath is referenced
from the outer scope and any errors from the cleanup remove call do not swallow
the original exception.
- [x] Around line 528-546: The deleteSessionTwinFiles method currently swallows
non-NotFound errors; update the catch block inside deleteSessionTwinFiles to log
the failure (including session.twinPath and the error stack/message) before
incrementing failed so you can diagnose issues; use the class's existing logger
(e.g., this.logger.error) or console.error if no logger exists, and keep the
NotFound branch unchanged.
- [c] Around line 75-81: resolveDefaultKatoDir currently returns
DEFAULT_KATO_DIRNAME when resolveHomeDir() is undefined, which can cause
unexpected files in CWD; update resolveDefaultKatoDir to detect the missing home
dir and either log a warning (e.g., console.warn or a provided logger) that it's
falling back to DEFAULT_KATO_DIRNAME, or make the function accept an optional
strict flag/optional logger parameter and throw an Error when strict is true;
reference resolveDefaultKatoDir, resolveHomeDir, and DEFAULT_KATO_DIRNAME when
making the change so callers can opt into strict behavior or see a clear warning
when the fallback is used.

In `@apps/daemon/src/writer/recording_pipeline.ts`:
- [c] Around line 88-90: The RecordingPipelineLike interface currently has
appendToDestination optional; make it required by removing the optional marker
so the signature reads appendToDestination(input: AppendToDestinationInput):
Promise<MarkdownWriteResult>; then update every implementation/class that
implements RecordingPipelineLike to provide that method with the exact signature
(implementors must import AppendToDestinationInput and return
Promise<MarkdownWriteResult>), and run TS compile to fix any missing method
errors and adjust callers if needed.


## Codex feedback

Cancelled ([c]) as wrong-headed for current design:

session_twin_mapper.ts sessionId swap: would break current provider-session identity expectations in runtime snapshots.
provider_ingestion.ts large hydrate extraction: refactor-only, no correctness/security payoff right now.
session_state_store.ts warning/strict fallback for missing home dir: changes function contract/noise without clear runtime gain.
recording_pipeline.ts making appendToDestination required: optionality is currently used intentionally for compatibility/fallback handling.
Color commentary: I added a focused validateDestinationPath hook in the recording pipeline so persistent ::start can validate/canonicalize destination before mutating metadata, which addresses the real bug without forcing broader interface churn.