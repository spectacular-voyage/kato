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
  - a 3-second grace period (a batch waits at most 1 second, and the daemon polls every second);
  - degrade a root after 3 misses within 10 minutes.
- **A degraded root stays degraded until the daemon restarts.** Promoting it back after a long run of fully reported changes is possible, but out of scope.
- **Windows appends through a long-held handle.** Does Claude Code or Codex write that way? The hot poll covers active sessions either way, and the held-open-handle integration test asserts ingestion, not which mechanism delivered it.

## Decisions

- **The watcher leads, and its reliability is measured rather than assumed per platform.** A blind watcher looks healthy. Trust comes from seeing that what stats and walks find, the watcher had already reported.
- **Active sessions are stat-polled every 5 seconds regardless.** It costs a few dozen stats, and it keeps the delay people notice independent of the watcher.
- **Degradation is per root.** One root on a network share should not put 19 local roots back on a 5-second walk. Walks take a list of roots, and a walk removes only sessions under the roots it walked.
- **A path the watcher reports is resolved on its own, by code shared with the walk.** Each provider gets one function that describes a single file, and both the walk and watch events call it, so the two can't drift. When two files claim the same session id, `compareDiscoveredSessionCandidates` picks the winner, as the walk's dedupe does.
- **Ignored paths are not remembered (changed during implementation).** Names that can't be transcripts are dropped without any I/O. Every other reported path costs one `lstat`; a Codex rollout also costs its first-line read, but only when the meta cache has no entry for it. Codex `exec` rollouts, dedupe losers, and files with an incomplete first line are therefore re-described on each event rather than walked. A stamp map would save one stat per event and add state that can go stale.
- **A batch waits at most 1 second (added during implementation).** `watchFsDebounced` restarted its 250 ms debounce on every event under any root, so steady writes anywhere would postpone every batch. Postponed batches would then look like misses.
- **Watcher paths are mapped back to the configured root (added during implementation).** FSEvents reports resolved paths, for example `/private/var/...` for `/var/...`. Without the mapping, a symlinked root on macOS would never match a tracked path and would degrade itself.
- **Ingestion untracks a session whose file is gone.** A remove event then drops the session at once instead of waiting for the next walk. A file that reappears is picked up again by its create event.
- **`Deno.watchFs` stays in `core/watcher.ts`.** The batch gains a runtime-neutral, optional `rescan` flag. The miss-detection and scheduling logic doesn't depend on which watcher reports the events, per [[dev.general-guidance]]. The runner still calls `Deno.lstat` and `Deno.realPath` alongside its existing `Deno.stat` calls, all in this one file.
- **No persisted-state or configuration change.** The intervals are constants that tests can inject.

## Contract Changes

- **Internal:**
  - `DebouncedWatchBatch` gains `rescan?: true`, and `WatchDebounceOptions` gains `maxWaitMs` (default 1 second).
  - The `discoverSessions` runner option takes the roots to walk. Existing fakes that ignore the argument still type-check.
  - New runner options: `describeSessionFile`, `isSessionFilePath`, and `discoveryTiming`. Without `describeSessionFile`, a reported unknown path walks its root, as before.
  - Each provider exports `describe*SessionFile`. Gemini also gets a `GeminiDiscoveryCache`.
  - `discoveryIntervalMs` now means the walk interval for trusted roots, with a new default of 5 minutes.
  - `FileProviderIngestionRunner.listTrackedSessions()` is new, for diagnostics and tests.
- **Status snapshot:** `watchDegraded?: DaemonWatchDegradedStatus[]`, present only while something is degraded. Each entry has:
  - `provider`;
  - `reason`, either `watcher-down` or `missed-changes`;
  - `roots`;
  - `since`;
  - `missedChanges`, optional.

  `readWatchDegraded()` filters out malformed entries, as `readIngestionFailures()` does. `kato status` shows a "Watcher Degraded" section; Kato Web can follow later.
- **Log events:**
  - `provider.ingestion.watch.rescan` (info);
  - `provider.ingestion.watch.restarted` (info);
  - `provider.ingestion.watch.degraded` (warn);
  - `provider.ingestion.watch.missed` (debug);
  - `provider.ingestion.discovery.walked` (debug, one per walk).

  `provider.ingestion.watch.failed` now carries `retryInMs`, and a `hint` when the inotify watch or instance limit is the cause.

## Testing

Unit tests (`tests/provider-ingestion-discovery_test.ts`) drive the runner with an injected clock, a fake `watchFs`, and a spy on walks. They use real temp files whose mtimes are set with `Deno.utime`, so no stat seam was needed.

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

Integration tests (`tests/provider-ingestion-watch-integration_test.ts`) use the real watcher on a temp root and run in CI on Linux, macOS and Windows:
- **Watcher alone:** walks and the hot poll are pushed out to an hour, so only the watcher can deliver changes. The test checks a nested directory created together with its file, an append, a rename, and a delete, each within 10 seconds, with exactly one walk.
- **Held-open handle:** an append through a handle kept open is ingested, with the hot poll on.
- **Symlinked root:** a root reached through a symlink (made with `ln -s`, since `Deno.symlink` needs unscoped write permission) is watched under its configured path. Skipped on Windows.

`tests/daemon-watcher_test.ts` covers the `rescan` flag and the batch's 1-second wait cap. With the cap removed, the steady-writes test fails, which shows it can catch a regression. `tests/watch-degraded-status_test.ts` covers the heartbeat, `readWatchDegraded()` and `kato status`.

## Verification

Measure on galactica before and after, using the method in [[task.2026.2026-11-09-state-store-io]]: `/proc/PID/stat` and `/proc/PID/io` over 180-second windows, starting 10 minutes after the daemon starts. Record:
- CPU;
- read and write syscall rates;
- walk counts from the debug log;
- the time from starting a new Claude session to its appearing in `kato status`.

**Before release (2026-11-10, galactica):** I ran `main` and this branch side by side in a script, not as the daemon. Each run used the 26 configured roots, the real watcher, and an in-memory store, wrote nothing, and polled every second as the daemon does. A parent process sampled each run's `/proc/PID/stat` and `/proc/PID/io` over 150 seconds, after a 60-second warmup.

| Run | CPU | Read syscalls/s | Write syscalls/s |
|---|---|---|---|
| `main`, discovery and watching only | 9.4% | 2,607 | 1,468 |
| branch, discovery and watching only | 0.9% | 1,435 | 17 |
| `main`, with ingestion | 12.6% | 2,886 | 1,747 |
| branch, with ingestion | 5.4% | 1,545 | 37 |

- **Discovery:** about 90% less CPU. Write syscalls, which track the async filesystem calls, fell 99%. The `main` rows match the installed daemon's profile in [[task.2026.2026-11-09-state-store-io]]: about 2,900 reads and 1,800 writes a second.
- **Remaining reads:** about 1,400 a second in both builds. I attributed these to the watcher, but the installed daemon makes only 46–94 reads a second (below), so they were not the watcher's. Their source in the script was not investigated.
- **The ingestion rows overstate ingestion.** The script keeps no session state, so a session's first change after start parses its transcript from the beginning: 88,903 events in 120 seconds. The daemon resumes from saved cursors.
- **Branch debug counts:** over 120 seconds the Claude and Codex runners did not walk at all, and nothing degraded. Only the missing Gemini root was walked every 5 seconds, which costs one stat.

**After release (2026-11-12, galactica):** the same sampler on the installed daemon. `v0.2.19` had been running for 2 days 10 hours with 22 active sessions. I sampled it for 180 seconds, installed `v0.2.20` with `npm install -g`, ran `kato restart`, and sampled two 180-second windows starting 10 and 13 minutes after the restart, with 26 active sessions.

| Measure | `v0.2.19` | `v0.2.20` |
|---|---|---|
| CPU | 10.3% | 3.0–3.6% |
| Read syscalls/s | 1,282 | 46–94 |
| Write syscalls/s | 1,883 | 103–123 |
| Writes (`wchar`) | 0.26 MB/s | 0.29–0.43 MB/s |
| RSS | 887 MB | 490–516 MB |

- **CPU** fell by about two thirds and filesystem syscalls by about 95%. The remaining 3% is not attributed.
- **Writes** did not change. They are metadata saves, a separate task (see [[task.2026.2026-11-09-state-store-io]] Open Issues).
- **RSS** fell mostly because of the restart, not this change.
- **New sessions:** three transcripts (Claude subagents) were created in the 16 minutes after the restart. Kato created each one's metadata 0.75–1.46 seconds after the file was created, measured from the file's birth time to the metadata's `createdAt`. A walk of the 26 roots found no transcript created since the restart that Kato had missed.
- **Watcher health:** `kato status` showed no Watcher Degraded section. The operational log had no `watch.failed`, `watch.restarted`, `watch.rescan` or `watch.degraded` entries.
- **Walk counts** were not recorded. The daemon logs at `info`, and `provider.ingestion.discovery.walked` is a debug event.

## Non-Goals

- Fewer metadata saves, the write half of the state-store Open Issues. That is a separate task.
- Changes to the 1-second poll loop or to ingestion itself.
- Replacing `Deno.watchFs`, which belongs to the platform migration.
- User-facing settings for the intervals.
- Walks gated on directory mtime.

## Implementation Plan

- [x] Contracts:
  - `rescan` on `DebouncedWatchBatch`;
  - a `discoverSessions` that takes the roots to walk;
  - a per-provider single-file describe function, shared with the walks;
  - a Gemini discovery cache, keyed by mtime and size.
- [x] Key tests: equivalence, healthy-watcher walk counts, and the blind watcher's hot poll and degrade.
- [x] Watch events:
  - classify paths per provider;
  - resolve unknown transcripts and directories on their own;
  - stop walking everything for other paths.
- [x] Remember ignored paths with their stamp. Cancelled; see Decisions.
- [x] Watcher lifecycle:
  - handle `rescan`;
  - restart after a failure with backoff (5 seconds, 30 seconds, then every 5 minutes);
  - treat roots as degraded while the watcher is down;
  - do a full walk after a restart;
  - start watching a root that appears after start.
- [x] Watcher batches wait at most 1 second; watcher paths are mapped back to symlinked roots.
- [x] Hot poll: stat sessions changed in the last 10 minutes every 5 seconds, and keep the tracked mtime current after ingestion.
- [x] Miss detection and per-root degradation:
  - full walks every 5 minutes for healthy roots and every 5 seconds for degraded ones;
  - a walk of some roots drops only those roots' sessions.
- [x] Status and logs:
  - `watchDegraded` in the status snapshot and `kato status`;
  - the new log events;
  - the inotify-limit hint.
- [x] Integration tests pass on Linux.
- [x] Integration tests pass in macOS and Windows CI (PR #58). The watcher alone delivers each change on both, and the symlinked-root test passes on macOS. It is skipped on Windows.
- [x] Docs: discovery and the watcher in [[dev.codebase-overview]].
- [x] Release notes, written at release ([[release-notes.v0.2.20]]).
- [x] `deno task ci`: 998 root tests and 12 web tests passed.
- [x] Measure discovery before and after on galactica, in a script (see Verification).
- [x] Measure the installed daemon on galactica after release: CPU 10.3% to 3.0–3.6%, and new sessions appear within 1.5 seconds (see Verification).
