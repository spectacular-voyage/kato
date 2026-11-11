---
id: ourbp3q6fu2rdg4h9yhge3k
title: Watcher-Led Session Discovery
desc: Stop rewalking every provider root every 5 seconds. The file watcher drives discovery, active sessions are stat-polled, and only roots whose watcher is shown to miss changes fall back to fast walks.
updated: 1794379357715
created: 1794379357715
---

## Goal

The daemon finds new and changed provider transcripts as quickly as it does today while doing a small fraction of today's filesystem work. On galactica, steady-state CPU drops from about 11% of a core to under 4%, measured the same way. Persisted state, configuration, and what users see do not change. A root whose watcher proves unreliable keeps today's behaviour.

## Summary

- Discovery rewalks every root every 5 seconds, even though the daemon also watches those roots. That walk is most of the daemon's remaining CPU ([[task.2026.2026-11-09-state-store-io]], Open Issues).
- The watcher becomes the primary signal. When it reports a path Kato doesn't know, Kato handles that path or that directory on its own instead of walking every root.
- Sessions whose transcript changed in the last 10 minutes are stat-polled every 5 seconds. Active sessions never depend on the watcher alone.
- Each root still gets a full walk every 5 minutes as a safety net. It also gets one right after a watcher overflow (`rescan`), a failure, or a restart.
- Every stat and walk checks whether the watcher reported what it found. A root whose watcher misses changes is marked degraded and goes back to a 5-second walk. The log and `kato status` both say so.
- Smaller fixes ride along:
  - restart a failed watcher;
  - stop letting non-transcript files and Codex `exec` rollouts trigger rediscovery;
  - cache Gemini discovery reads.

## Discussion

### How discovery works now

The daemon calls `poll()` on each provider's `FileProviderIngestionRunner` (`apps/daemon/src/orchestrator/provider_ingestion.ts`) every second (`DEFAULT_POLL_INTERVAL_MS` in `daemon_runtime.ts`).

- **The walk.** `poll()` runs `discoverAndTrackSessions()` whenever `needsDiscovery` is set or 5 seconds (`DEFAULT_DISCOVERY_INTERVAL_MS`) have passed. That calls the provider's `discoverSessions()`, which walks every root:
  - Claude: a `readDir` of every directory and a `stat` of every `.jsonl` file.
  - Codex: the same, plus each rollout's first-line `session_meta`, which `CodexSessionMetaCache` keeps from being read again.
  - Gemini: every `session-*.json` is read and parsed in full on every walk, plus a stat.
- **The walk does four jobs:**
  - finds new files;
  - marks files with a changed mtime as dirty;
  - drops sessions whose files are gone;
  - catches whatever the watcher missed.
- **The watcher.** `watchFsDebounced` (`apps/daemon/src/core/watcher.ts`) wraps `Deno.watchFs`, recursively over the roots, with a 250 ms debounce. `onWatchBatch` marks known paths dirty.
- **Unknown paths walk everything.** Any path Kato doesn't track sets `needsDiscovery`, which walks every root on the next poll. Paths that do this include:
  - Claude's `memory/*.md`, `tool-results/*.txt`, and `subagents/*.meta.json`;
  - Codex `exec` rollouts, which discovery finds but skips, so they are never tracked;
  - duplicates dropped by `dedupeDiscoveredSessions`;
  - transcripts whose first line is still incomplete.
- **A failed watcher stays failed.** If the watch loop throws, `start()` logs `provider.ingestion.watch.failed` and never restarts it. From then on the 5-second walk is the only thing finding changes.
- **Overflows are ignored.** When the OS event queue overflows and events are lost, `Deno.FsEvent.flag` is `"rescan"`. Kato ignores it, and the 5-second walk is what recovers.

So the 5-second walk is load-bearing in ways that aren't obvious. Lengthening it alone would turn watcher failures and overflows into ingestion delays of minutes, with nothing in the log.

### Size on galactica (2026-11-10)

- **Roots:** 26 configured.
  - 19 Claude: `~/.claude/projects`, plus per-account homes under `~/.local/share/seat-monitor/claude/*/projects`. These are the `CLAUDE_CONFIG_DIR` and `CODEX_HOME` directories of agents running on galactica, written directly on local disk, not synced copies.
  - 6 Codex.
  - 1 Gemini root, which does not exist.
- **Walk cost:** about 3,870 directories, 2,230 Claude transcripts and 3,280 Codex rollouts. Each walk is about 9,400 directory reads and stats. At a 5-second interval that is about 1,900 filesystem calls a second. The CPU profile in [[task.2026.2026-11-09-state-store-io]] was taken at 21 roots and about 6,700 calls per walk.
- **Activity in a 10-minute window:**
  - 35 transcripts changed: 25 Claude and 10 Codex.
  - 9 non-transcript files changed under the Claude roots. Every watch batch containing one of them triggers a walk of all 19 Claude roots.
- **inotify:** `fs.inotify.max_user_watches` is 259,201. The recursive watch needs about one watch per directory, so about 3,900.

**After the change:** about 38 filesystem calls a second, roughly 2% of today's discovery work:
- a full walk every 5 minutes, about 31 calls a second on average;
- about 35 stats every 5 seconds, about 7 a second.

### Platform watchers

Deno's watcher is the Rust `notify` crate.

- **Linux (inotify):**
  - `notify` keeps one watch per directory and adds watches for new directories as they appear.
  - Files created in a new directory before its watch exists are missed, so an event for a new directory must lead to reading that directory.
  - `notify` reports a queue overflow as `rescan`; `max_queued_events` is 16,384 here.
  - Running out of `max_user_watches` makes the watcher throw.
- **macOS (FSEvents):**
  - Watching is recursive natively.
  - Events are coalesced and can arrive late.
  - `notify` passes on "must scan subdirectories" (events were dropped) as `rescan`.
- **Windows (ReadDirectoryChangesW):**
  - Watching is recursive natively.
  - A buffer overflow should arrive as `rescan` (not verified).
  - NTFS may not report appends made through a handle the writer keeps open until the file's metadata is flushed.
- **Silent blindness:** these watchers see nothing from writers on the far side of:
  - WSL's `/mnt/*` (9p);
  - NFS or SMB mounts;
  - some container bind mounts.

  The watcher starts fine and simply reports nothing. No platform check can detect that up front, so this design measures the watcher instead of trusting it per platform.

[[task.2026.2026-11-10-platform-migration]] lists `Deno.watchFs` among the hardest APIs to port. Miss detection does not depend on which watcher sits underneath, so it carries over to whatever replaces it.

### Alternatives considered

- **Raise the interval to 60 seconds and stop.** It is one line and gets about 92% of the saving. But a dead or blind watcher then delays every change by up to a minute, with nothing logged, and overflows still depend on the walk.
- **Re-read only directories whose mtime changed.**
  - This finds new files without reading every directory.
  - It does not catch appends, because appending to a file doesn't change its directory's mtime, so per-file stats stay.
  - Directory mtime granularity and update rules differ between filesystems.
  - With healthy roots walked only every 5 minutes, the remaining saving is small.
  - It may be worth revisiting for degraded roots only.

## Open Issues

- **The thresholds are first guesses.** Tune them from the logs after release:
  - a 10-minute hot window;
  - a full walk every 5 minutes;
  - a 2-second grace period;
  - degrade a root after 3 misses within 10 minutes.
- **A degraded root stays degraded until the daemon restarts.** Promoting it back after a long run of fully reported changes is possible, but out of scope.
- **Windows appends through a long-held handle.** Does Claude Code or Codex write that way? The hot poll covers active sessions either way, and the integration test records what the watcher actually reports.
- **The `max_user_watches` error.** When the watcher throws because of it, log the sysctl to raise, not just the raw error.

## Decisions

- **The watcher leads, and its reliability is measured rather than assumed per platform.** A blind watcher looks healthy. Trust comes from seeing that what stats and walks find, the watcher had already reported.
- **Active sessions are stat-polled every 5 seconds regardless.** It costs a few dozen stats, and it keeps the delay people notice independent of the watcher.
- **Degradation is per root.** One root on a network share should not put 19 local roots back on a 5-second walk. Walks take a list of roots, and a walk removes only sessions under the roots it walked.
- **A path the watcher reports is resolved on its own, by code shared with the walk.** Each provider gets one function that describes a single file, and both the walk and watch events call it, so the two can't drift. When two files claim the same session id, `compareDiscoveredSessionCandidates` picks the winner, as the walk's dedupe does.
- **Ignored paths are remembered with their file stamp.** That covers:
  - non-transcript names;
  - Codex `exec` rollouts;
  - dedupe losers;
  - files whose first line is incomplete. These are retried when the stamp changes.
- **`Deno.watchFs` stays in `core/watcher.ts`.** The batch gains a runtime-neutral `rescan: boolean`. The reliability logic lives in the runner and uses no `Deno.*` API, per [[dev.general-guidance]].
- **No persisted-state or configuration change.** The intervals are constants that tests can inject.

## Contract Changes

- **Internal:**
  - `DebouncedWatchBatch` gains `rescan: boolean`.
  - The `discoverSessions` runner option takes the roots to walk.
  - Each provider adds a function that describes a single file.
- **Status snapshot:** it gains an optional per-provider watch state: `watching`, `restarting`, or a list of degraded roots with their miss counts. Readers that don't know the field ignore it. `kato status` shows degraded roots; Kato Web can follow later.
- **Log events:** `provider.ingestion.watch.rescan`, `provider.ingestion.watch.restarted` and `provider.ingestion.watch.degraded` are new.

## Testing

Unit tests drive the runner with an injected clock, a fake `watchFs`, and spies on walks and stats. The runner already accepts the clock and the watcher as options; the stat spy needs a new seam.

- **Healthy watcher:** over 11 simulated minutes, walks happen only at start and at 5 and 10 minutes. New and changed transcripts are ingested from events alone.
- **Unknown paths:**
  - An event for a non-transcript path walks nothing.
  - An event for a new transcript tracks and ingests that file without a walk.
  - Repeated writes to a Codex `exec` rollout walk nothing after the first classification.
- **New directories:** an event for a new directory reads it and finds a file created there before a watch could exist.
- **Overflow and failure:**
  - A `rescan` batch walks every root on the next poll.
  - A watcher that throws is restarted with backoff.
  - While it is down, roots are walked every 5 seconds, plus once more after it comes back.
- **Blind watcher:**
  - An active session's append is ingested within 5 seconds through the hot poll.
  - After the miss threshold, the root is degraded, logged once, and walked every 5 seconds. Other roots are not affected.
- **Grace period:** a change detected within the grace period after its event is not counted as a miss.
- **Removals and renames:** remove and rename events drop or move the session without a walk. A walk of a degraded root does not drop sessions under other roots.
- **Equivalence:** after a scripted sequence of creates, appends, renames, deletes, duplicates and `exec` rollouts, the tracked set built from events equals what a fresh full walk produces.
- **Gemini:** an unchanged session file is not read again on the next walk.

Integration tests use the real `watchFsDebounced` on a temp root and run in CI on Linux, macOS and Windows. Each test does one change:
- append to a transcript;
- create a nested directory and immediately a file in it;
- rename a transcript;
- delete one;
- append through a handle kept open.

Each asserts ingestion within 10 seconds, counts the walks, and records whether the change arrived through the watcher or the hot poll.

## Verification

Measure on galactica before and after, using the method in [[task.2026.2026-11-09-state-store-io]]: `/proc/PID/stat` and `/proc/PID/io` over 180-second windows, starting 10 minutes after the daemon starts. Record:
- CPU;
- read and write syscall rates;
- walk counts from the debug log;
- the time from starting a new Claude session to its appearing in `kato status`.

## Non-Goals

- Fewer metadata saves, the write half of the state-store Open Issues. That is a separate task.
- Changes to the 1-second poll loop or to ingestion itself.
- Replacing `Deno.watchFs`, which belongs to the platform migration.
- User-facing settings for the intervals.
- Walks gated on directory mtime.

## Implementation Plan

- [ ] Contracts:
  - `rescan` on `DebouncedWatchBatch`;
  - a `discoverSessions` that takes the roots to walk;
  - a per-provider single-file describe function, shared with the walks;
  - a Gemini discovery cache keyed by inode, size, and mtime.
- [ ] Key tests before the rewrite: equivalence, healthy-watcher walk counts, and the blind watcher's hot poll and degrade.
- [ ] Watch events:
  - classify paths per provider;
  - resolve unknown transcripts and directories on their own;
  - remember ignored paths with their stamp;
  - stop setting `needsDiscovery` for everything else.
- [ ] Watcher lifecycle:
  - handle `rescan`;
  - restart after a failure with backoff (5 seconds, 30 seconds, then every 5 minutes);
  - treat roots as degraded while the watcher is down;
  - do a full walk after a restart.
- [ ] Hot poll: stat sessions changed in the last 10 minutes every 5 seconds, and keep the tracked mtime current after ingestion.
- [ ] Miss detection and per-root degradation:
  - full walks every 5 minutes for healthy roots and every 5 seconds for degraded ones;
  - a walk of some roots drops only those roots' sessions.
- [ ] Status and logs:
  - watch state in the status snapshot and `kato status`;
  - the three new log events;
  - the `max_user_watches` hint.
- [ ] Integration tests on Linux, macOS and Windows CI.
- [ ] Docs: discovery and the watcher in [[dev.codebase-overview]]; release notes.
- [ ] `deno task ci`.
- [ ] Verify on galactica and record the before and after numbers here.
