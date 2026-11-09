---
id: vxpac7llzdqfrcp8aivksmf
title: Incremental Provider Parsing
desc: Stop re-reading and re-parsing whole provider transcripts on every append; remove the 512 MiB V8 string ceiling that silently stalls ingestion of large sessions.
updated: 1794175200000
created: 1794175200000
---

## Goal

Make provider ingestion cost proportional to the bytes appended since the last ingest, not to the total transcript size, so the daemon idles when agents are idle and never stops capturing a session because its transcript grew past a V8 limit.

## Summary

On galactica (v0.2.15, 2026-11-08) `kato-daemon` held its main thread at ~100% for its whole 10 h lifetime (25,745 s user + 3,022 s sys on the main thread; RSS 2.7 GiB, peak 4.1 GiB). Root cause: every ingest of a dirty session re-reads and re-processes the entire provider transcript from byte 0, even when the cursor is at EOF. The watched seat-monitor roots now contain ~35 actively growing transcripts of 30–973 MB each (~5 GB total), so one poll round costs far more than the poll interval and the runner never catches up.

A second, worse consequence: Codex session `01a17e49-d3bd-7bb1-a490-a361a5a1a319` reached 1.02 GB. `Deno.readTextFile` cannot produce a string above V8's ~512 MiB limit, so every ingest throws `failed to allocate string; buffer exceeds maximum length`. Its persisted cursor is frozen at 532,656,971 bytes and its twin has not advanced since 2026-11-02 19:21. That session has been silently uncaptured for six days; the only signal is 22,667 `provider.ingestion.parse_error` lines in `operational.jsonl`.

## Discussion

### Evidence

- `kato-daemon` is a `deno compile` binary; "the main thread" is the V8/JS event-loop thread. The `tokio-runtime-w` threads are Deno's blocking-I/O pool (each ~590 s sys time — file reads), not kato code.
- The main thread is not in a non-yielding loop: 82.4 M voluntary context switches in 10 h (~2,300/s). The poll loop does `await sleep(pollIntervalMs)` (`daemon_runtime.ts`); each round simply takes longer than the interval because `poll()` ingests dirty sessions serially.
- `asm_sysvec_call_function` at the top of a gdb backtrace is the kernel's IPI handler (TLB shootdowns / cross-CPU function calls). It is consistent with constant mmap/munmap of huge buffers (1 GB `readTextFile` buffers, V8 large-object space), not by itself evidence of a spin loop.
- Discovery is stat-only and is not the problem. Of 5,676 watched files (54.8 GB), only the ~35 growing ones matter.
- `operational.jsonl`: 19,969 of the last 20,000 events are the same `parse_error` for the 1 GB file, cadence ~40–60 s. That cadence is the length of one poll round.

### Measured cost of one "nothing new" ingest (fromOffset = EOF, nice 10, galactica)

| Path | File | Time | Rate |
|---|---|---|---|
| `parseCodexEvents` | 91.7 MB Codex rollout | 587 ms | ~6.4 ms/MB |
| `readLatestCodexCompactionAnchor` | same file | 949 ms | ~10.3 ms/MB |
| `parseClaudeEvents` | 85.5 MB Claude transcript | 433 ms | ~5.1 ms/MB |

Every Codex ingest pays both Codex rows (~16 ms/MB). With ~2.7 GB of active Codex files (excluding the unreadable 1 GB one) and ~1.2 GB of active Claude files, one round where each active session appended once costs ~50 s of main-thread CPU — matching the observed error cadence. Over a session's lifetime the cost is O(n²) in transcript size.

### Where the whole-file work happens

1. `apps/daemon/src/providers/codex/parser.ts` `parseCodexEvents`: `Deno.readTextFile` → `split("\n")` → `utf8ByteLength(line)` (allocates a new `TextEncoder` and a full `Uint8Array` per line just to count bytes) → `JSON.parse` on **every** line, including lines before `fromOffset`, because parser state (`model`, `currentTurnId`, `turnFinalized`, `pendingRequestUserInputCalls`, `pendingToolCallNames`) is rebuilt from the top each time.
2. `apps/daemon/src/orchestrator/provider_ingestion.ts` `readLatestCodexCompactionAnchor`: runs on every Codex ingest with `fromOffset > 0`; streams the whole file through a byte-at-a-time JS loop and decodes every line to find the last `"type":"compacted"` record.
3. `apps/daemon/src/providers/claude/parser.ts` `parseClaudeEvents` / `parseLines`: skips `JSON.parse` before `fromOffset` but still reads, decodes, splits, and byte-counts the whole file. The Claude session-titles task ([[task.2026.2026-07-28-claude-session-titles]]) explicitly leaned on this whole-file read for its one-time title backfill; that backfill must keep working.
4. The `parse_error` branch in `ingestSession` returns without backoff, without invalidating anything, and without surfacing state, so a deterministic failure is retried on every append forever.

### Resume semantics that constrain the design

- The persisted `ingestCursor` is the highest cursor the parser yielded (the line end of the last yielded event or title update), **not** EOF. Lines after it are re-read next time. A cached parser state is only valid if it is the state immediately after the line ending at that exact offset.
- Codex compaction backtrack sets `fromOffset = compactionLineEnd - 4096`, which is normally mid-line. Today, line boundaries are computed from byte 0, and Codex includes the line *containing* `fromOffset` (`lineEnd > fromOffset`) while Claude skips it (`lineStart < fromOffset`). For offsets on a line boundary the two rules coincide.
- Twin bootstrap and truncation reset parse from 0; those are inherently linear one-off passes and are fine once they stop being quadratic.

### Should the persisted cursor move to EOF?

Moving `ingestCursor` to EOF does not require back-scanning. Back-scanning would only be one (unreliable) way to rebuild Codex parser state on a cold start, and a cold start needs that state no matter where the cursor sits: the cursor is a byte position, while the parser also needs `model`, `currentTurnId`, `turnFinalized`, and the pending-call maps from earlier lines. A bounded back-scan can find the last `turn_context` or `task_started`, but cannot reliably recover pending tool calls, which can be arbitrarily far back. The robust options are a linear pass from 0 (phase 1, once per session per daemon start) or persisting the parser state next to the cursor (phase 2).

What an EOF cursor would buy is not re-reading the tail between the last event and EOF, and a simpler snapshot point (the parser's end-of-loop state instead of a snapshot at the last yield). Both can be had without touching the persisted cursor: the runner's in-memory resume entry records the persisted cursor it was taken with *and* the end of the last newline-terminated line the parser consumed, plus the parser state at that point. Lines between the two produced no events and, being complete and deterministic given the same state, would produce none on re-read, so resuming at the later offset is equivalent.

Persisting EOF also has real drawbacks: it changes a persisted contract, and it changes when the Codex compaction backtrack fires (its trigger is "a new compaction marker at or before the cursor"), whose rationale is undocumented. The backtrack fired 9 times in the last 20k galactica log events, mostly because the slow pre-parse anchor scan races with appends; a 4 KiB rewind plus content-based dedupe also suggests a defence against Codex rewriting the file around compaction rather than strictly appending. Metadata write volume is not a drawback: metadata is already rewritten on every append because the source mtime changes.

### Discovered during implementation: Codex parser state depended on `fromOffset`

Two latent parser bugs made "resume from saved state" non-equivalent to today's behavior, and had to be fixed first:

1. `finalizeAssistant` only set `turnFinalized` when `lineEnd > fromOffset`, so lines before `fromOffset` never finalized a turn and every incremental parse started with `turnFinalized = false`.
2. Only `user_message` reset `turnFinalized`; `task_started` did not. Automated seat sessions have turns with no `user_message` (one galactica twin has 1,975 finals and the twins contain 10 user messages in total).

Combined: a full parse from 0 suppressed every final answer after the first in such sessions, while incremental parses only produced per-turn finals because each cursor boundary accidentally reset `turnFinalized`. On a real 92 MB automated session, the old parser's full parse emitted 185 events; the fixed parser emits 357, the difference being exactly 172 per-turn `task_complete` finals and nothing removed. Any twin rebuild from source (bootstrap) under the old parser would have silently dropped those finals. (Modern Codex puts `final_answer` text in `output_text` parts, which `extractMessageText` ignores, so finals come solely from `task_complete`; unchanged here.)

Fix: `task_started` resets `turnFinalized`, and finalization updates `turnFinalized` for lines before `fromOffset` without emitting. Parser state is now path-independent, so a parse from F equals the full parse filtered to `lineEnd > F` (verified at every line boundary of every fixture and at sampled boundaries of real transcripts). The only steady-state output change is that a final or commentary duplicated across an ingest boundary is no longer re-emitted.

### Implementation notes

- Measured on galactica after the change: the 973 MB transcript that had been failing parses in a 3.7 s cold linear pass at 128 MB RSS; resuming from its checkpoint takes 0.7 ms.
- Claude and Codex keep their established inclusion rules for a mid-line offset (Claude: `lineStart >= fromOffset`; Codex: `lineEnd > fromOffset`). They only differ for a line first seen unterminated; tests assert each provider's rule.
- The cold ingest of a session (from 0) skips the compaction scan and so never records `ingestAnchor`; the first warm ingest after it backtracks once with dedupe. That is pre-existing behavior, left unchanged; it forces one linear pass per such session.
- `resolveHeadSnippet` stops reading as soon as it finds the first user message instead of reading the whole file first.

### Galactica verification (2026-11-08)

The first deploy fixed the parsing cost but the daemon still sat at about 37–43% of a core, reading ~21–29 MB/s. Two pre-existing per-poll costs, measured on galactica's data (3,280 Codex rollouts / 21 GB, 2,364 Claude transcripts, 2,308 session metadata files):

- Codex discovery (every 5 s) opened every rollout and read 32 KB to get the session id from line 1: 653 ms CPU per pass (13% of a core), ~105 MB read per pass. Rollouts are append-only, so the parsed `session_meta` is now memoized per path and inode and re-read only for new, replaced, or shrunken files: 117 ms per pass. Claude discovery (walk + stat, no reads) costs ~276 ms per pass and is unchanged.
- The daemon loop's recording pass called `listSessionMetadata()` (read and parse every `*.meta.json`, ~130 ms CPU) on every 1 s poll, although it only needs the in-memory snapshots' sessions (17–23 of 2,308); merge-before-save did the same per changed session, and the summary cache reloaded every busy poll though only heartbeats use it. The recording pass and merge now read only the involved sessions via `listSessionMetadataForKeys()` (still fresh from disk, so web-console writes are seen), and summary metadata loads only when a heartbeat is due.

Result after redeploy (15 s windows): steady state 9–15% process CPU (main thread 5–9%) and ~2 MB/s reads, down from 94% before this work. Occasional 25–36% windows are each active session's one-time linear pass (Codex state + compaction scan) on its first append after the restart. No `parse_error` since the restart; peak RSS ~350 MB vs 2.4 GB.

Session `01a17e49-d3bd…` was not re-ingested at startup: the runner only proactively ingests files modified after daemon start, and that rollout's last write predates the restart. A read-only replay of the daemon's code path from its persisted cursor (532,656,971) produced the 924 pending events (484 assistant messages, 220 tool calls/results) in 3.4 s at 128 MB, and the warm resume read 256 bytes. It will catch up on its next append.

### Startup catch-up of stale sessions

The 01a17e49 case was not unique. A read-only scan of galactica's metadata found 20 tracked sessions (12 Claude, 8 Codex) whose source mtime was newer than `lastObservedMtimeMs` with unread bytes past the persisted cursor: 6.6 GB of backlog in total, mostly left behind by the old daemon's `parse_error` loop, the largest a 3.2 GB tail of a 3.7 GB Codex rollout. Four of the Claude sessions have workspace recordings switched on.

The runner now catches these up after a restart instead of waiting for each session's next append:

- Only newly discovered sessions that miss the existing "modified since start" gate are candidates, and only those with persisted metadata. Untracked history stays lazy, so startup never replays the 3,280-rollout archive.
- A candidate is stale when its mtime is newer than `lastObservedMtimeMs` and, for byte-offset cursors, its size differs from the cursor. The size check matters for Codex: resuming from a persisted cursor costs a full warm-up pass plus a compaction scan, so a touched-but-unchanged 3.7 GB rollout must not qualify.
- Metadata is read once per discovery pass with `listSessionMetadataForKeys()` for the candidates only.
- Stale sessions are queued most recent first and drained one per poll, so control requests, heartbeats, and the recording pass run between catch-ups. Any ingest (for example from a watch event) satisfies a pending catch-up, so nothing is ingested twice.
- `provider.ingestion.catch_up.queued` logs the count, total backlog bytes, and session ids.

Memory budget check, read-only replay through the real parser from the persisted cursors: the 3.2 GB backlog produced 2,958 events in 10.6 s at 216 MB peak RSS, and the retained snapshot (last 10,000 events, `JSON.stringify` size as the store estimates it) is 2 MB against the 500 MB `daemonMaxMemoryMb` budget. The 842 MB backlog: 2,077 events, 4.8 s, 1.2 MB. So catch-up cannot trip the fatal single-session budget error into a restart loop; the worst single catch-up holds the loop for roughly 11–15 s.

## Open Issues

- Persisting Codex parser resume state (resume offset + `CodexParserState`) in session metadata so a daemon restart does not need one linear pass per active session. Phase 1 keeps it in memory only; cold-start cost is one linear pass per session that becomes dirty (~5 GB ≈ tens of seconds, once). If added, it is stored as its own field next to `ingestCursor`, not by redefining `ingestCursor`. Revisit only if restarts are frequent.
- Whether Codex really rewrites rollout files around compaction (see the cursor discussion). The resume guard below makes the design safe either way; confirming it would tell us whether the backtrack can eventually be simplified.
- `pendingToolCallNames` / `pendingRequestUserInputCalls` are never pruned for calls that never receive output. Not a CPU problem, but the resume snapshot clones them; consider a cap if snapshots get large.
- A single large catch-up still runs inside one poll (about 11 s for galactica's 3.2 GB backlog). Bounding bytes per ingest would need the Codex resume checkpoint to stop cleanly mid-stream; not worth it unless multi-GB backlogs become routine.
- Follow-ups observed during the investigation, intentionally out of scope here: `shared/daemon-control.json` is 1.2 MB and rewritten every few seconds; Codex `*.meta.json` files (~90 KB) are rewritten on every append; `daemonMaxMemoryMb` reads like a process RSS cap but only budgets in-memory snapshots. Log growth is handled by [[task.2026.2026-11-08-log-rotation]].

## Decisions

- Introduce one shared byte-level JSONL line reader and route all JSONL provider parsing and the compaction scan through it. It opens the file, seeks to the requested offset, reads chunks, finds newlines with `Uint8Array.indexOf(0x0a)`, decodes only complete lines with a single reused `TextDecoder`, and reports `lineStart`/`lineEnd` byte offsets directly (no re-encoding to count bytes). No transcript-sized string is ever built, which removes the 512 MiB ceiling.
- The reader yields a final unterminated segment with `terminated: false`, preserving today's behavior that a complete JSON object at EOF without a trailing newline is parsed, while a partial line in mid-write fails `JSON.parse` and is re-read next ingest.
- The reader's boundary-alignment rule matches the caller's current semantics: Claude-style callers that start at a mid-line offset discard bytes through the next newline (byte at `offset - 1` is checked to tell a line start from mid-line).
- Claude parsing becomes a pure seek-and-stream from `fromOffset`. The one-time title backfill becomes an explicit streaming pass from 0 filtered to title records.
- The persisted `ingestCursor` keeps its current meaning (line end of the last yielded event or title). The in-memory resume point runs further, to the end of the last newline-terminated line consumed. No back-scanning anywhere.
- Codex parsing becomes a resumable state machine. `CodexParserState` holds the five cross-line fields. The parser reports its end-of-pass state together with `resumeOffset`, the end of the last newline-terminated line it consumed. The runner keeps an in-memory `Map<sessionId, { filePath, persistedCursor, resumeOffset, guard, state }>`.
  - Hit (`fromOffset === cached.persistedCursor`, same `filePath`, file size ≥ `resumeOffset`, guard matches): seek to `resumeOffset` and resume from the cached state.
  - Miss (cold start, compaction backtrack to a mid-line offset, truncation reset, file path change, bootstrap from 0, prior parse error): one linear streaming pass from 0 with today's semantics, emitting only events past `fromOffset`.
  - Invalidate the entry on parse error, truncation, untracking, or source path change.
- `readLatestCodexCompactionAnchor` becomes incremental: cache `{ filePath, scannedThrough, latest }` per session, where `scannedThrough` is the end of the last newline-terminated line scanned; scan only `[scannedThrough, EOF)`; reset on truncation. Match the `"type":"compacted"` byte pattern before decoding when practical.
- Parse failures get per-session exponential backoff (initial 30 s, doubling, cap 15 min), reset on success or truncation. Log `provider.ingestion.parse_error` on the first failure and on each backoff escalation, with `consecutiveFailures` and `nextRetryAt`, instead of on every attempt.
- Resume guard: each cached resume point (Codex state cache, Claude seek, compaction scan cache) stores a hash of the up-to-256 bytes immediately before its offset. Before seeking, re-read and compare those bytes; a mismatch means the file was rewritten rather than appended, so treat it as a miss (linear pass) and invalidate. This costs one small read per ingest and protects against non-append rewrites, including any Codex compaction rewrite.
- Surface ingestion failures. The daemon status snapshot gains a top-level `ingestionFailures` list, independent of the `sessions` liveness filter so a stale-but-failing session still shows. Each entry has `provider`, `sessionId`, `error`, `firstFailedAt`, `lastFailedAt`, `consecutiveFailures`, and `nextRetryAt`. Entries clear on the next successful ingest. Kato Web shows a failure count on Summary and an "ingestion failing since …" badge on the matching Sessions row; `kato status` lists failing sessions.
- `utf8ByteLength` in `apps/runtime/src/utils/text.ts` reuses a module-level `TextEncoder` for its remaining callers.
- No change to persisted cursor semantics or the session metadata schema.

### Resume scenario table

| Scenario | Path | Expected |
|---|---|---|
| Steady-state append, cursor at last event | Codex hit / Claude seek | Reads only appended bytes; events identical to full parse |
| Daemon restart, persisted cursor > 0 | Codex miss → linear pass; Claude seek | Same events as today; Codex one-time linear cost |
| Compaction backtrack to mid-line offset | Codex miss → linear pass | Same events as today (line containing offset included) |
| File truncated / replaced smaller | Existing reset to 0; caches invalidated | Same as today |
| Twin bootstrap | Linear pass from 0 | Same as today |
| Trailing partial line at EOF | Unterminated segment fails `JSON.parse`, not past cursor | Re-read next ingest; no lost event |
| Transcript > 512 MiB | Streaming reader | Ingests normally |
| Only non-event lines appended since last ingest | Resume at in-memory `resumeOffset` | Reads only new bytes; persisted cursor unchanged |
| File rewritten in place (same or larger size) | Resume guard mismatch → miss → linear pass | Same events as a fresh full parse; caches invalidated |
| Deterministic parse failure | Backoff + `ingestionFailures` entry | Bounded retries and log volume; visible in status, Web, CLI |

## Contract Changes

- Internal only: `parseCodexEvents` gains an optional resume-state input and resume-point output; the shared line reader is a new internal module; `ProviderIngestionRunner` gains in-memory resume, anchor-scan, and failure-backoff caches.
- Operational log: `provider.ingestion.parse_error` gains `consecutiveFailures` and `nextRetryAt` attributes and is emitted only on first failure and backoff escalation.
- Shared status contract: `DaemonStatusSnapshot.ingestionFailures?: DaemonIngestionFailureStatus[]` (fields as in Decisions). Optional, so older readers ignore it.
- No change to `ingestCursor` meaning or the session metadata schema.

## Testing

- Line reader unit tests (with an injectable small chunk size): lines spanning chunks, multibyte UTF-8 split across a chunk boundary, a single line larger than many chunks, empty lines, `\r\n` (preserve current tolerance), terminated vs unterminated final line, `fromOffset` at 0 / line start / mid-line / EOF / beyond EOF, exact `lineStart`/`lineEnd` byte offsets.
- Equivalence property tests (the key tests): for every Codex and Claude fixture under `tests/fixtures/`, for every line boundary `k`, events from a full parse filtered to `lineEnd > k` equal events from a resumed parse at `k`. For Codex, chained ingests `0→a→b→EOF` using the cached resume states equal a single pass.
- Regression test that would have caught this: ingest a fixture, append one line, ingest again with an instrumented reader, and assert bytes read on the second ingest ≈ appended bytes (both parser and compaction scan).
- Existing compaction-backtrack, truncation, bootstrap, and title-backfill ingestion tests pass unchanged.
- Backoff test: a parser that throws is not re-invoked within the backoff window, is re-invoked after it, and success resets the counter and log suppression.
- Resume guard test: rewrite a fixture's earlier bytes in place (same length and longer) between ingests; the next ingest takes the linear path and matches a fresh full parse.
- Resume-past-cursor test: append only non-event lines (for example `token_count`), ingest, then append an event line; events match a full parse and the second ingest reads only new bytes.
- Status surfacing tests: a failing session appears in `ingestionFailures` with counts and timestamps, stays listed when it is stale, and disappears after a successful ingest; Kato Web Summary/Sessions and `kato status` render it.
- `deno bench`: first vs steady-state ingest on a generated ~50 MB transcript, to keep the O(append) property visible.
- Manual on galactica: install the build, restart the daemon, confirm main-thread CPU drops to near idle between appends, `parse_error` stops, and session `01a17e49-d3bd…` resumes from cursor 532,656,971 and its twin advances.

## Non-Goals

- Gemini parsing (single JSON document, `item-index` cursors, small files).
- Persisting parser resume state across restarts (phase 2 if needed).
- Moving parsing into a Worker or changing poll scheduling; once ingest is O(append), the main thread has headroom.
- Changing persisted cursor semantics.
- Audit-log rotation, `daemon-control.json` write volume, and `daemonMaxMemoryMb` naming (separate follow-ups).

## Implementation Plan

- [x] Add the shared JSONL line reader (seek, chunked `indexOf`, reused decoder, byte offsets, terminated flag, boundary alignment, injectable chunk size) with unit tests.
- [x] Add equivalence property-test harness over existing Codex and Claude fixtures (initially asserting current full-parse behavior, so it guards the refactor).
- [x] Switch `parseClaudeEvents` to seek-and-stream via the reader; keep title backfill as an explicit streaming pass from 0.
- [x] Extract `CodexParserState`; make `parseCodexEvents` stream via the reader, accept resume state, and report the resume snapshot at the highest yielded cursor.
- [x] Add the runner's Codex resume cache (persisted cursor + in-memory `resumeOffset`) with hit/miss/invalidate rules from the scenario table.
- [x] Add the resume guard (hash of bytes before the offset) for the Codex cache, Claude seek, and compaction scan cache.
- [x] Make `readLatestCodexCompactionAnchor` incremental via the reader with a per-session scan cache.
- [x] Add per-session parse-failure backoff and reduced-volume `parse_error` logging.
- [x] Reuse a module-level `TextEncoder` in `utf8ByteLength`.
- [x] Add the "second ingest reads only appended bytes" regression tests (parser and runner level, via `jsonlReaderStats`).
- [x] ~~Add a `deno bench`~~ — cancelled: the byte-count regression tests pin the O(append) property deterministically; real-transcript timings are recorded above.
- [x] Fix Codex parser path dependence (`task_started` resets `turnFinalized`; pre-offset finalization updates state) with per-turn-final and no-duplicate tests.
- [x] Add `ingestionFailures` to the daemon status snapshot and render it in Kato Web (Summary count, Sessions badge) and `kato status`.
- [x] Update [[dev.codebase-overview]] and [[dev.decision-log]].
- [x] Memoize Codex discovery's first-line `session_meta` per path and inode (found during galactica verification), with tests.
- [x] Stop per-poll full metadata listings: keyed `listSessionMetadataForKeys()` for the recording pass and merge-before-save, summary metadata only at heartbeat time (found during galactica verification), with a loop test that fails on the old runtime.
- [x] Catch up stale tracked sessions after a restart (mtime newer than `lastObservedMtimeMs` and unread bytes), one per poll, most recent first, with tests that fail without the queue.
- [x] Clear the 13 `apps/web/deno.lock` advisories that failed `deno audit` (6 high: browserslist, nanoid, source-map-js, vite/launch-editor). In-range bumps only: vite 7.3.6 → 7.3.7 (floor raised to `^7.3.7`), esbuild 0.27.7 → 0.28.2, browserslist 4.29.5, nanoid 3.3.20, source-map-js 1.2.2, baseline-browser-mapping 2.11.35, @babel/core 7.29.13; `@fresh/core` and `@fresh/plugin-vite` unchanged. `deno audit --fix` was a no-op, so the affected lock entries and their dependents were pruned and re-resolved with `deno install`.
- [x] Add to next release notes ([[release-notes.v0.2.16]]).
- [x] `deno task ci` — audit clean on all four lockfiles, 968 tests passed.
- [x] Manual verification on galactica: CPU 94% → ~12% steady, no `parse_error`; session `01a17e49-d3bd…` recovery verified by read-only replay, live catch-up pending its next append.
