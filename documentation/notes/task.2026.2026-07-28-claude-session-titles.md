---
id: task-2026-07-28-claude-session-titles
title: Claude Session Titles For Snippets
desc: Prefer Claude's own session titles (custom or AI-generated) over first-user-message snippet reconstruction.
updated: 1785266853000
created: 1785265932657
---

## Goal

Use the session names Claude Code itself maintains — user-assigned custom titles first, then Claude's AI-generated titles — as the display title for Claude sessions, falling back to the current first-user-message reconstruction only when neither exists.

## Summary

Claude Code appends title entries directly into the session transcript jsonl under `~/.claude/projects/<project>/<sessionId>.jsonl`:

- `{"type":"custom-title","customTitle":"...","sessionId":"..."}` — written when the user names the session (e.g. `/rename`). Rare but authoritative.
- `{"type":"ai-title","aiTitle":"...","sessionId":"..."}` — auto-generated titles, re-appended as the conversation evolves. Common (observed thousands of entries across real transcripts, including duplicates).

Both entry types can appear multiple times per file; the last occurrence of each type wins. The live registry `~/.claude/sessions/<pid>.json` also carries `name`/`nameSource`, but it is PID-keyed, exists only while a session process runs, and `nameSource:"derived"` values (e.g. `kato-f7`) are worthless placeholders — the jsonl entries are the durable source.

Kato currently drops these lines: `parseLines` in `apps/daemon/src/providers/claude/parser.ts` accepts only `user`/`assistant`/`system` entries, and `extractSnippet` (`shared/src/status_projection.ts`) reconstructs a snippet from the first user message. The result is snippets that often do not describe the conversation.

## Discussion

Snippets are deliberately sticky today: ingestion passes `snippetOverride ?? previousSnippet ?? extractSnippet(events)` (`apps/daemon/src/orchestrator/ingestion_runtime.ts`, `provider_ingestion.ts`) so a mid-file resume does not relabel a session from a later message. Provider titles must behave differently: a later `ai-title`/`custom-title` line must replace an earlier title of the same type, otherwise renames never propagate. The title is therefore carried as its own metadata, never funneled through the sticky snippet channel.

Parser interface: the Claude parse generator yields only `{event, cursor}` items and ingestion advances `latestCursor` exclusively from yielded items (`provider_ingestion.ts:89`, `:1572`), so a title-only append at EOF would leave the cursor unchanged and the session would report "not updated" every poll (`:1868`) while re-reading the same tail forever. The parse item type becomes a union (`{event, cursor} | {titleUpdate, cursor}`); title-only records must advance the provider cursor exactly like events.

Scan/backfill semantics: `parseClaudeEvents` already reads the whole source file into memory per parse (`Deno.readTextFile`), so a "bounded" backfill scan would save nothing on I/O while risking missing an early custom title or a late AI rename. Correctness wins: the backfill for snapshots that predate this feature is a full-file line scan filtered to the two title types, retaining only the last occurrence of each; memory stays flat because no events are materialized. It runs once per Claude session lacking title metadata (piggybacking on the existing discovery/ingestion pass) and is not repeated after that.

Codex has no equivalent metadata today — its `payload.summary` entries are reasoning content that the codex parser converts into `thinking` events, not session titles. The snapshot fields are still named provider-neutrally (`providerTitle`, `providerTitleSource`) so other providers can adopt them if they grow real title metadata, but no codex/gemini wiring happens here.

There is an existing manually-set session-level title: `outputMetadataDefaults.displayTitle` in persisted session metadata, editable from the web (`session_metadata_actions.ts`) and already consulted when creating recordings (`session_recording_actions.ts:905`). Provider titles slot in below it. The single effective-title precedence (highest wins) is:

1. Explicit per-output title entered in the recording form at creation time.
2. Session `outputMetadataDefaults.displayTitle` (manual, Kato-side — also the surface the twin viewer edits, [[task.2026.2026-07-28-session-twin-viewer]]).
3. `providerTitle` with `providerTitleSource: "custom"`.
4. `providerTitle` with `providerTitleSource: "ai"`.
5. Reconstructed sticky snippet (unchanged current behavior).

`filenameSlug` remains a separate explicit input; when absent, `{snippetSlug}` derives from the effective title via the existing slug rules.

Status compatibility: daemon status JSON keeps the existing `snippet` field and legacy consumers keep working — projection writes the effective title (levels 3–5; levels 1–2 are recording-time concerns) into `snippet`, and adds `titleSource` alongside it so new consumers can distinguish custom/ai/reconstructed. The status schema change is additive.

## Open Issues

- None.

## Decisions

- Parse `custom-title` and `ai-title` lines in the Claude parser layer; last occurrence per type wins; a record whose `sessionId` does not match the transcript's session is ignored.
- Parse items become a union of event items and title-update items; both advance the provider cursor, so a title-only append marks the session updated exactly once.
- Persist `providerTitle: string` and `providerTitleSource: "custom" | "ai"` in session snapshot/status metadata and persisted session meta; `custom` always outranks `ai` regardless of file order.
- Effective-title precedence as listed in Discussion; provider titles never overwrite `outputMetadataDefaults.displayTitle` and never get overwritten by the reconstructed snippet.
- Title normalization: trim; collapse internal newlines/control characters to single spaces; cap persisted titles at 200 characters (truncate with `…`); empty-after-normalization titles are discarded. Slug derivation reuses the existing title→slug rules with a 60-character slug cap; a title whose slug normalizes to empty falls through to the next precedence level for slug purposes.
- Secrets policy: titles run through the same session secrets pipeline as events with the same fail-closed defaults — `off` stores as-is, `detect` stores and emits the detection audit event (counts only, no title text), `redact` stores the redacted form; any processing failure drops the title update and keeps the previous value.
- Backfill: full-file line-filtered scan for Claude snapshots lacking title metadata, once per session.
- `SessionMetadataV1` gains the two fields; the metadata clone routine (`session_state_store.ts:143`) is updated in the same change, with round-trip and clone tests. Downgrade policy: older binaries drop the fields on their next metadata rewrite; the daemon re-derives them from the transcript on a later pass, so no migration is needed — documented, not compensated.
- Status projection keeps writing the effective title into the existing `snippet` field (additive `titleSource` alongside); no status schema version bump.
- The ephemeral `~/.claude/sessions/<pid>.json` registry is not a title source.

## Contract Changes

- Claude parser: union parse-item type carrying title updates with cursors; title records validated, normalized, and surfaced to ingestion.
- Ingestion/snapshot store: `SessionSnapshotUpsert` (or parallel metadata channel) carries `providerTitle`/`providerTitleSource`; title-only updates count as session updates; sticky-snippet behavior unchanged as fallback.
- Persisted session meta (`~/.kato/shared/sessions/*.meta.json`): new optional fields plus clone/round-trip support.
- `projectSessionStatus`: effective title into `snippet`, new `titleSource` field.
- Consumers (web sessions rows, `resolveSessionSnippet`, session-snippet API, recording default title, `{snippetSlug}`, markdown title resolution, CLI status) pick up the effective title through the existing snippet/title paths per the precedence table.

## Testing

- Parser: title lines parsed with last-wins per type; custom-over-ai precedence; malformed, empty, wrong-`sessionId`, oversized, and non-ASCII titles; title-only append at EOF advances the cursor (session reports updated once, then idle); UTF-8 byte-offset correctness around title lines.
- Ingestion: title captured from offset-0 read; later title update replaces stored title; reconstructed snippet never overwrites a title; file truncation/replacement behavior unchanged.
- Backfill: pre-existing snapshot without titles gains them via the scan (including custom-in-head plus ai-in-tail); sessions with no title lines behave byte-for-byte as today; scan runs once.
- Normalization: trim/collapse/cap cases; empty-slug fallthrough.
- Secrets policy: all three modes, audit event without title text, processing-failure fallback.
- Persistence: metadata round-trip and clone retain the fields; daemon restart with persisted-only sessions projects titles; status JSON carries `titleSource`; legacy status consumers still read `snippet`.
- Precedence: each level of the effective-title table, including `outputMetadataDefaults.displayTitle` and recording-form titles winning over provider titles, and `{snippetSlug}`/markdown-title derivation.
- Ordering: title-only changes update `updatedAt`/session ordering consistently with other metadata updates (pin behavior by test).
- Run focused parser/ingestion/projection suites plus `deno task ci`.

## Non-Goals

- No codex/gemini title extraction (codex `payload.summary` is reasoning content, not a title).
- No renaming of Claude sessions from Kato (Kato never writes title lines into provider transcripts).
- No retroactive retitling of already-written output files.
- No use of the live `~/.claude/sessions` PID registry.
- No new manual-title field (the manual surface remains `outputMetadataDefaults.displayTitle`).

## Implementation Plan

- [x] Extend the Claude parser with the union parse-item type capturing validated, normalized title updates that advance the cursor.
- [x] Thread `providerTitle`/`providerTitleSource` through ingestion, snapshot store, persisted session meta (including the clone routine), and status projection with the effective-title precedence.
- [x] Add the full-file backfill scan for Claude snapshots lacking title metadata.
- [x] Run titles through the secrets pipeline with fail-closed handling and count-only audit events.
- [x] Wire consumers: web sessions rows, snippet resolution/API, recording default title, `{snippetSlug}`, markdown title, CLI status.
- [x] Tests: parser (last-wins, validation, normalization, cursor advance), runner (title capture, title-only append, redact-mode secrets, Claude backfill with scan caching), store precedence, projection preference.
- [ ] Remaining tests: secrets `detect`/`off` modes on titles, metadata clone round-trip, UTF-8 offsets around title lines, `updatedAt` ordering pin.
- [ ] Follow-up (CodeRabbit, PR #45): invalid/skipped title lines do not advance the parse cursor (consistent with other skipped trailing lines, but a trailing malformed title re-parses each poll); consider eager provider-title display for persisted-only Sessions rows (currently lazy via the redacting snippet API so no unredacted metadata field reaches the browser directly).
- [x] Update [[user-guide.web]], [[dev.codebase-overview]], and [[dev.decision-log]] (release notes at next `bump:version`; [[dev.event-kinds]] untouched — titles are a parse-item channel, not an event kind).
- [x] Focused validation: full standard test slices (923 passed), `deno task check`, `deno task lint`.
- [ ] Run `deno task ci` before PR.
