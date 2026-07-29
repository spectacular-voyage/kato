---
id: task-2026-07-28-session-twin-viewer
title: Session Twin Viewer
desc: Read the persisted twin's conversation content from Kato Web, and set the session display title from there.
updated: 1785266853000
created: 1785265932657
---

## Goal

Let an operator open a session from Kato Web and read the twin's actual conversation content, so they can judge what a session contains and give it a better title/snippet/filename than the auto-derived one.

## Summary

Today the only content signal on `/sessions` is the one-line snippet (first user message, often unrepresentative). There is no way to inspect a conversation from the web app. Add a session detail page rendering the persisted twin's events — user/assistant messages primary; other event kinds collapsed — with a metadata header and links from `/sessions` and `/recordings` rows, plus the ability to set the session's display title right where you can finally see the content.

Work splits into three explicitly sequenced slices:

1. Bounded twin read API + read-only viewer page.
2. Display-title editing on the viewer, reusing the existing session-level `outputMetadataDefaults.displayTitle` surface.
3. Optional provider-source replay fallback for twin-less sessions (bounded), if still wanted after slices 1–2.

## Discussion

Route identity: sessions are keyed by Kato's internal `sessionId` everywhere in the web app today (session links via `session_routes.ts:35`, snippet API via `live_routes.ts:91`). The detail page keeps that stable internal key — no new composite provider+providerSessionId key.

Bounded reads do not exist yet and must be built: `readTwinEvents` (`apps/runtime/src/orchestrator/session_state_store.ts:640`) reads and parses the entire twin file, and `resolveSessionSnippet` consumes that full array. Twins can be large ([[task.2026.2026-07-10-session-twin-size]]), so slice 1 adds a bounded twin reader and a paged API on top of it.

Pagination contract: twin events carry authoritative monotonic `seq` values (`shared/src/contracts/session_twin.ts:33`); pages are seq-cursor-based, not page-numbered (page numbers are unstable while the file grows). API accepts `beforeSeq`/`afterSeq` plus a count capped at 200 events and a response cap of 1 MB (whichever hits first), returns events in seq order with `hasMore` on both ends. Malformed lines, duplicate seqs, and out-of-order lines are skipped and surfaced as a per-page `skippedLines` count; an oversized single event is truncated for display with an explicit marker; an empty or wholly corrupt twin renders an explicit empty/corrupt state, not an error page. Concurrent append is safe by construction: seq cursors never shift existing events.

Security posture follows the snippet resolver, which deliberately re-redacts twin history with fail-closed defaults (`session_snippets.ts:20,77`; proven by `tests/web-session-snippets_test.ts:158`) because legacy twins may predate ingestion-time filtering. The viewer re-applies the same redaction pipeline to every served page; it never trusts stored twin content. The twin path is resolved canonically from session identity under the sessions root — never trusted from `metadata.twinPath` as stored (`session_state_store.ts:548` reads it unvalidated) — with symlink-escape tests. All content renders as escaped plain text in slice 1 (no Markdown rendering), with XSS fixtures for message and tool payloads. Read endpoints sit behind the same auth as other web surfaces; mutations additionally get CSRF and same-origin coverage (enforced by `web_app.ts:96` middleware — tests must exercise it).

Header: built from what persisted metadata actually has (`SessionMetadataV1`: state `createdAt`/`updatedAt`, `nextTwinSeq`, provider identity, working directory, workspace outputs). Event count displays as `nextTwinSeq - 1` (labelled approximate when `skippedLines` > 0); "activity" means state-update time (`updatedAt`), not per-event time — twin event timestamps are optional (`session_twin.ts:20`) and no new summary metadata is maintained during append in this task.

Rendering classification is defined over stored twin event kinds, independently of any workspace-output writer flags (those belong to individual output attachments — `session_state.ts:52` — and a session can have several with different policies, so they are irrelevant to the viewer): `message.user`/`message.assistant` render expanded; `thinking`, tool call/result, `system`, `user.kato-command`, decision events, and `provider.raw` render collapsed with kind labels (tool payloads summarized as name + truncated payload with per-event expand); unknown/future kinds render collapsed as labelled raw JSON. Nothing is silently dropped.

Display title (slice 2): reuse the existing session-level `outputMetadataDefaults.displayTitle` — already persisted, already editable via `session_metadata_actions.ts:294`, already consulted at recording creation (`session_recording_actions.ts:905`) — rather than inventing a parallel field. The viewer adds a set/clear control for it. Precedence is owned by the effective-title table in [[task.2026.2026-07-28-claude-session-titles]] (this surface sits above provider titles; explicit recording-form titles still win at creation time). Setting/clearing it does not rewrite existing Markdown frontmatter, matching current session-default title behavior (`session_metadata_actions.ts:308` rewrites tags only) — stated in the UI copy. Known limitation, accepted for this task and documented: session metadata saves rewrite the whole document under a process-local web lock only (`session_mutation_lock.ts`, `session_state_store.ts:493`), so a concurrent daemon metadata rewrite can race a web save; this task does not build cross-process locking, but must not widen the write surface beyond the existing displayTitle field, and adds a regression test pinning last-writer-wins on that field. Cross-process merge-safety is tracked as an open issue.

Source replay (slice 3, optional): replay accumulates every parsed event server-side (`provider_source_replay.ts:114`) and Claude parsing reads whole files, so replay for the viewer must be bounded (reuse the bounded-page shape over a replay window) and re-redacted like twins. Only offered as an explicit action when no twin exists, mirroring `resolveSessionSnippet`'s `allowSourceReplay`. If slices 1–2 make it unnecessary, drop it.

This task supersedes the stub [[task.2026.2026-03-22-conversation-detail-page]] (already marked); recordings rows linking to their session's detail page lands in slice 1.

## Open Issues

- Cross-process merge-safe session-metadata mutation (web vs daemon writer) — needed eventually, out of scope here; candidate follow-up task.

## Decisions

- Detail page keyed by Kato's internal `sessionId`, linked from `/sessions` and `/recordings` rows.
- Slice 1 builds a bounded twin reader + seq-cursor paged API (count ≤ 200, response ≤ 1 MB, `hasMore`, `skippedLines`, truncation markers) and a read-only viewer.
- Re-redact every served page through the existing fail-closed snippet redaction pipeline; canonical twin path from session identity, never from stored `twinPath`.
- Escaped plain-text rendering only; expanded messages, collapsed everything else including unknown kinds; no writer-flag involvement.
- Header from existing metadata only; event count = `nextTwinSeq - 1`; activity = `updatedAt`.
- Slice 2 reuses `outputMetadataDefaults.displayTitle` (set/clear from the viewer); no new title field; no frontmatter rewrite; last-writer-wins pinned by test.
- Slice 3 (bounded source replay behind an explicit action) is optional and re-evaluated after slices 1–2.

## Contract Changes

- Runtime: bounded twin read (seq-window) API in the session state store.
- Web: session detail route + paged twin events endpoint (auth'd; mutation endpoints CSRF/same-origin enforced); `/sessions` and `/recordings` rows link to it; viewer set/clear control writing `outputMetadataDefaults.displayTitle` through the existing metadata action path.

## Testing

- Bounded reader/API: first/middle/last windows, `beforeSeq`/`afterSeq` edges, count and byte caps, `hasMore` both directions, empty twin, missing twin, corrupt file, malformed/duplicate/out-of-order lines (`skippedLines`), oversized single event truncation, concurrent append stability, unknown session id.
- Security: legacy twin with unredacted secret is redacted in every page; symlinked/escaping `twinPath` ignored in favor of canonical resolution; XSS fixtures in message and tool payload content render inert; endpoints require auth; title mutation requires CSRF + same-origin.
- Rendering model: kind classification incl. `user.kato-command`, decision, `provider.raw`, unknown kinds; tool payload truncation with expand.
- Header: counts and timestamps from metadata; approximate labelling with skipped lines.
- Display title: set/clear round trip via the existing action path, propagation to sessions rows and recording default title, no frontmatter rewrite, last-writer-wins regression on concurrent metadata rewrite.
- Links from `/sessions` and `/recordings` rows.
- Run focused web/runtime tests and the production web build.

## Non-Goals

- No editing or deleting of twin events (Maintenance owns twin lifecycle).
- No new title/metadata fields; no Markdown rendering of content; no frontmatter rewrites on title change.
- No renaming of already-written output files.
- No live-tail view; no cross-session search.
- No cross-process metadata locking (tracked as open issue).
- No new summary metadata maintained at append time.

## Implementation Plan

- [x] Slice 1: bounded seq-window twin reader (`readTwinEventsWindow`) in the session state store with canonical path resolution (twin path derived from session identity, stored `twinPath` never followed).
- [x] Slice 1: paged, re-redacted twin view loader with count/byte caps, `hasOlder`/`hasNewer`, `skippedLines`, per-event truncation (server-rendered page shares the loader; a JSON endpoint can wrap it later if needed).
- [x] Slice 1: session detail route `/sessions/:sessionId` (header + classified event rendering as escaped plain text, seq-cursor Older/Newer/Latest paging), linked from `/sessions` and `/recordings` rows.
- [ ] Slice 2: display-title set/clear on the viewer via the existing `outputMetadataDefaults.displayTitle` action path.
- [x] Slice 1 tests: seq-window paging, malformed/duplicate-line skipping, kind classification, legacy-twin secret redaction, unknown session.
- [ ] Remaining tests: byte-cap edge, oversized single event, symlinked twin path, XSS fixtures (rendering is escaped-by-construction via JSX text nodes/`<pre>`), concurrent-append stability.
- [ ] Follow-up (CodeRabbit, PR #45): make the window reader I/O-bounded (single-pass streaming instead of reading/parsing the whole twin file per request; response is already bounded).
- [ ] Slice 3 (re-evaluate first): bounded source-replay fallback action for twin-less sessions.
- [x] Update [[dev.codebase-overview]] and [[user-guide.web]] (release notes at next `bump:version`).
- [x] Run focused validation and the production web build.
