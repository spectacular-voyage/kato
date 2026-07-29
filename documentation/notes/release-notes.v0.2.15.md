---
id: dlcegnjs7gmmat91hudhn4px
title: 'Release Notes v0.2.15'
desc: Claude session titles, auto-record conversation roots, a session twin viewer, and workspace auto-record visibility.
updated: 1785286254529
created: 1785286254529
---

## Summary

`v0.2.15` makes session labels meaningful and automatic recording usable in real project layouts.

Claude sessions now display Claude's own session titles: a `/rename` custom title first, then Claude's AI-generated title, falling back to the first user message only when neither exists. Titles flow everywhere labels are used — the Sessions list, default recording titles, `{snippetSlug}` filenames, markdown output titles, and CLI status — and later renames propagate instead of being frozen to the first line of the conversation.

Automatic workspace recording previously matched only conversations whose working directory sat inside the workspace root. Since workspace roots are usually notes vaults nested inside project repos while conversations run at the repo root, that contract effectively never fired. Workspace config now accepts `autoRecordRoots`: a list of conversation directories (absolute, `~`, or workspace-root-relative), and a Claude conversation whose working directory is inside any listed root auto-records to that workspace. Auto-record misconfiguration is also no longer silent: broken workspace configs log once per distinct error instead of once per session per poll tick, and every `/workspaces` row shows the resolved auto-record state without opening the edit form.

Kato Web also gains a session twin viewer. Sessions with persisted Kato history link to a read-only `/sessions/<id>` page that renders the conversation content — messages expanded; thinking, tool, and system events collapsed — with paging for large histories and the same secrets redaction applied to every page served.

## User-facing Changes

- Claude session titles (`/rename` custom titles, then AI-generated titles) replace reconstructed first-message snippets across Sessions rows, snippet reveal, default recording titles, `{snippetSlug}`, markdown output titles, and `kato status`. Sessions ingested before this release recover their titles automatically via a one-time source scan.
- New workspace config key `autoRecordRoots` (editable in the Kato Web workspace config editor, one directory per line): Claude conversations whose working directory is inside any listed root auto-record to the workspace. An empty list keeps the previous workspace-root-only matching. Listed roots do not need to exist on disk; matching is lexical.
- Every `/workspaces` row now shows `auto-record on`, `auto-record off`, or `auto-record unavailable` (when the workspace config cannot be resolved).
- Auto-record failures caused by broken workspace configs are logged once per distinct error and clear when the config is repaired, instead of flooding the audit log every poll tick.
- New read-only session detail page at `/sessions/<id>`: conversation header (provider, working directory, activity, approximate event count, workspace outputs), messages rendered expanded with other event kinds collapsed, and `Older`/`Newer`/`Latest` paging. Linked via `View` from Sessions rows with a persisted twin and from Recordings rows.
- Twin content is re-redacted with the configured secrets policy (fail-closed default) on every page served, including history persisted before secrets filtering existed.
- `kato web start` accepts a `--host` override.
- Recording and capture filenames now derive `{timestampHumane}` and the other timestamp tokens from the conversation's newest event time instead of the command time, so recording an older conversation yields a filename dated to that conversation.
- The Sessions recording form receives lazily resolved snippets, so default titles work for sessions whose snippet required an on-demand reveal.

### Upgrade notes

- Older Kato binaries reject workspace configs containing the new `autoRecordRoots` key (configs fail closed on unknown keys). Remove the key before downgrading.
- Session metadata gains optional provider-title fields. Older binaries drop them on their next metadata rewrite; the daemon re-derives them from the transcript afterward, so no migration is needed.
- Auto-record remains Claude-only, defaults off, and only runs while the daemon is running in persistent mode.
- Existing output files are not renamed when a session's title changes.

## Developer-oriented Changes

- The Claude parser yields `custom-title`/`ai-title` transcript lines as title-update parse items that advance the ingest cursor (title-only appends register as session updates). Titles are normalized (trimmed, control characters collapsed, 200-char cap) and validated against the transcript's session id.
- Snapshot and persisted session metadata carry `providerTitle`/`providerTitleSource` with custom-outranks-ai precedence; status projection prefers the provider title in the existing `snippet` field and marks its origin via the additive `titleSource` field. Titles pass through the secrets pipeline fail-closed with count-only audit events.
- Workspace profiles expose resolved absolute `autoRecordRoots` (`resolveWorkspaceAutoRecordRoots`); auto-record workspace profiles resolve once per persistent poll pass (even with zero snapshots), with workspace-scoped resolution failures deduplicated per distinct error and session-scoped activation failures keeping per-session context.
- `PersistentSessionStateStore.readTwinEventsWindow` provides bounded seq-cursor twin reads (count and byte caps, `hasOlder`/`hasNewer`, malformed/duplicate lines counted as skipped) with the twin path derived canonically from session identity rather than trusted from stored metadata.
- `apps/web/deno.lock` bumps transitive postcss past GHSA-r28c-9q8g-f849 so `deno task audit --level=high` passes.
