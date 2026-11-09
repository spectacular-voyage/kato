---
id: me2xuq2vrathtfdoqfmnz2t
title: Recording Write Position
desc: Track each workspace recording's progress by source position so restarts and snapshot truncation stop dropping content; turn session twins on by default.
updated: 1794204385150
created: 1794204385150
---

## Goal

Recordings must not lose conversation content across daemon restarts or in long conversations, and content caught up at startup must reach recordings.

## Summary

Found while verifying startup catch-up ([[task.2026.2026-11-08-incremental-provider-parsing]]) on galactica: 16 stale sessions caught up, but none of the four with recordings switched on gained any content.

Each workspace output stored `writeCursor`, an index into the daemon's in-memory snapshot events. That array is rebuilt in every daemon process (from the twin when one exists, otherwise from content after the ingest cursor only) and keeps only the newest `maxEventsPerSession` (10,000) events. Two failures followed:

- After a restart, the stale index was clamped to the rebuilt snapshot's length, so the first batch was skipped. With twins off (the Claude default until now) this happened on every restart for every active recording.
- Once a conversation exceeded 10,000 events, the snapshot length stayed at the cap and `writeCursor` stayed equal to it, so nothing was appended again.

## Discussion

### Galactica impact (read-only analysis, 2026-11-08)

- 2,082 active outputs; 153 Claude outputs whose source changed more than 10 minutes after the last write. Parsing those transcripts found only three with events newer than the last write. The rest were trailing non-event lines (summaries, last-prompt records).
- The three are long conversations hit by the 10,000-event cap: `60702df5` (elena, 71,902 unwritten events after 2026-10-31), `d6313f21` (48,477) and `0d14f9bb` (47,610). The latter two exist as several diverged copies across seat-monitor accounts and their metadata points at an older copy, so their counts are against that copy.
- The only recording active across today's two restarts (deploy, reboot) had no new events in the restart windows, so nothing was lost there.
- Losses at earlier restarts that were followed by later writes sit mid-file behind newer timestamps; they cannot be found by timestamp and are not restorable in place.

### Why the source cursor

- Every parser sets `event.source.rawCursor` (Claude and Codex byte offsets, Gemini item index), and twin round trips preserve it as `source.cursor` while regenerating `eventId`.
- Codex events have no reliable timestamps (wall clock at incremental parse time, none from offset 0), so timestamp anchors do not work for Codex.
- Events within one source line share its cursor and are always written together, so "after the last event at or before the anchor" is exact.

## Decisions

- Workspace outputs gain optional `writeSourceCursor` (`byte-offset` or `item-index`). `writeCursor` keeps being written for older binaries.
- `resolveWorkspaceOutputWriteStart(output, events)`:
  1. With `writeSourceCursor`: index after the last event whose comparable cursor is ≤ the anchor; 0 when every comparable event is newer (rebuilt snapshot).
  2. Without it and `writeCursor > 0`: first event whose timestamp is after the active cycle's `lastWriteAt`; when timestamped events exist but none is newer, nothing is pending. `writeCursor` 0 means nothing was written yet (auto-record), so the whole snapshot is pending.
  3. Otherwise the clamped index.
- `setWorkspaceOutputWritePosition(output, events, writeCursor)` sets both fields; the persistent recording pass, daemon `::record`/`::capture`, and Kato Web start/restart/capture actions use it. Outputs without a source cursor record one on their first pass even when nothing is pending.
- Merge-before-save keeps the furthest `writeSourceCursor`.
- Log `recording.append.gap` when everything retained is newer than the write position and retention dropped events.
- `DEFAULT_GLOBAL_AUTO_GENERATE_TWINS = true` in `@kato/shared`. Existing configs with an explicit `false` keep it.
- No daemon-side backfill of the three long-session recordings: the daemon can only append what is in its 10,000-event window, which would leave a silent hole. Backfilling them is a separate decision.

## Open Issues

- Backfill for `60702df5`, `d6313f21`, `0d14f9bb` would need an offline append through the real recording pipeline (tens of thousands of events, ~20 MB of markdown each, into a git-tracked notes repo) and, for the two multi-copy sessions, a choice of source copy. Declined 2026-11-09.
- Discovery picks the newest of several same-id copies; catch-up skips sessions whose metadata source path differs. Whether to follow the newest copy (replay from 0 with dedupe) is undecided.

## Implementation Plan

- [x] Add `writeSourceCursor` to the session metadata contract, validator, and store clone.
- [x] Add `resolveWorkspaceOutputWriteStart` and `setWorkspaceOutputWritePosition`; use them in the persistent recording pass, daemon command paths, and Kato Web recording actions; merge the furthest position.
- [x] Log `recording.append.gap`.
- [x] Default `globalAutoGenerateTwins` to `true`.
- [x] Tests: resolver unit tests; runtime pass across truncation and restart rebuild (fails on the old runtime); gap warning; legacy migration by `lastWriteAt`.
- [x] Update [[release-notes.v0.2.16]], [[user-guide.configuration]], [[user-guide.troubleshooting]], [[dev.codebase-overview]], [[dev.decision-log]].
- [x] `deno task ci` — audit clean, 974 tests passed.
- [x] Deploy to galactica with `globalAutoGenerateTwins: true`: no errors or gap warnings; five active Claude sessions bootstrapped twins (2–39 MB, about a quarter of transcript size). No recorded conversation was active, so the live write path is verified by the sandbox run below.
- [x] End-to-end sandbox run with the real binaries (twins off, isolated `HOME`): record a Claude session, reply, stop the daemon, reply while down, start, reply again. New build: all four replies recorded exactly once, output anchored at the last byte offset. v0.2.15: the reply written while down and the first reply after the restart are both missing.
