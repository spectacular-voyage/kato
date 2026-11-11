---
id: oea8os99cy201r789x9e2ry
title: State Store I/O
desc: Stop the daemon's steady metadata reads and control-index rewrites so its I/O follows what arrived.
updated: 1794247218254
created: 1794247218254
---

## Goal

With nothing new arriving, the daemon should read and write close to nothing. Session metadata should be read when it changed, and the control index rewritten when a session is added or moves.

## Summary

Follow-up to [[task.2026.2026-11-09-snapshot-sharing]]. After v0.2.17 settled on galactica, the daemon still read a steady 4.4 MB/s and wrote about 1 MB/s while transcripts grew by about 0.013 MB/s. All reads came from the page cache (`read_bytes` near zero), so the cost was CPU (JSON parsing and validation) rather than disk; the writes were real disk writes with an fsync each.

Attribution without ptrace (`/proc/PID/io` sampled every 2 ms, inotify on every state and provider directory, and a tight `/proc/PID/fd` loop during read bursts):

| Source | Volume |
|---|---|
| Heartbeat: `listSessionMetadata()` reads all 2,316 metadata files (11.1 MB) every ~5.5 s | ~2.0 MB/s |
| Every poll: `listSessionMetadataForKeys()` re-reads the 33 snapshot sessions' files (3.0 MB) to see Kato Web writes | ~2.5 MB/s |
| Index: `daemon-control.json` (1.2 MB) rewritten and fsynced 0.6–0.8 times/s, because twin appends change the entry's `updatedAt` | ~0.9 MB/s written |
| Provider transcripts, twins, control queue | well under 0.1 MB/s |

Active sessions' metadata files average 93 KB; 97% of that is `recentFingerprints` (512 full fingerprint strings).

## Decisions

See [[dev.decision-log]] "Session State Store Skips Unchanged Files".

- Index entries drop `updatedAt` (nothing read it). The validator no longer requires it; entries from older indexes are normalized on load, and the field disappears on the next rewrite.
- Status reads metadata only for the snapshot store's sessions. Session statuses and the recording summary already only used those sessions, so the heartbeat output is unchanged.
- Listed metadata is re-read only when the file's inode, size, or mtime differs from the copy this store last read or wrote. Atomic writes return the temp file's `stat`, which the rename preserves.
- `writeAll` loops over `FsFile.write` for atomic writes and twin appends.

## Contract Changes

- `DaemonControlSessionIndexEntryV1` no longer has `updatedAt`; `isDaemonControlIndexV1` accepts entries with or without it. Schema version stays 1. v0.2.17 and earlier reject the new entries and rebuild the index once (a full scan of `sessions/`).
- `DaemonRuntimeLoopOptions.sessionMetadataRefreshIntervalMs` is removed.

## Testing

- The index is byte-identical after a touched twin append and a touched save, and is rewritten (without `updatedAt`) when a second session is added.
- An index written in the v0.2.17 format (entries with `updatedAt`) loads, heals, and is rewritten without the field.
- A same-inode, same-size, same-mtime in-place edit is served from the store's copy (the file was not re-read); a save by a second store (Kato Web) is seen by both listings. Disabling the stamp check fails this test.
- The runtime loop never calls `listSessionMetadata()` for status and asks only for the snapshot's session keys.
- Two existing tests wrote their corrupt and stale indexes to `<katoDir>/daemon-control.json`, which the store never reads (the index is `<katoDir>/shared/daemon-control.json`), so the rebuild and healing paths were untested. They now use `resolveDefaultDaemonControlIndexPath()`.

Offline on a copy of galactica's state (2,316 metadata files, 33 snapshot sessions), v0.2.17 vs this branch, two runs each (saves are fsync-bound and vary):

| Operation | v0.2.17 | Branch |
|---|---|---|
| Per-poll metadata read (33 keys) | 7.6–8.7 ms, 3.0 MB read | 1.0 ms, 0 read |
| Heartbeat metadata read | 89–133 ms, 11.4 MB read (full listing) | 1.0–1.1 ms, 0 read (33 keys) |
| `saveSessionMetadata` with `touchUpdatedAt` | 13–19 ms, 1.8 MB written | 2–10 ms, 100 KB written |
| Index rewrites in 21 touched saves | 21 | 0 |

## Verification

Released as `v0.2.18` and installed on galactica with `npm install -g` (2,322 sessions; about 21 active after start). Both versions were sampled with `/proc/PID/io`, `/proc/PID/stat`, and the index file's inode polled every 50 ms. The `v0.2.17` daemon had been running for hours. The `v0.2.18` windows start 8 and 11 minutes after a restart; the first window after the restart (5 minutes in) was still catching up, at 6.9 MB/s of real disk reads.

| Measure | v0.2.17 (120 s) | v0.2.18 (two 180 s windows) |
|---|---|---|
| Reads (`rchar`) | 4.58 MB/s | 0.10–0.18 MB/s |
| Writes (`wchar`) | 1.51 MB/s | 0.35–0.42 MB/s |
| Control index replaced | 109 times (54.5/min) | 0 |
| CPU | 15.1% | 11.4–12.8% |
| RSS | 0.67 GB | 0.62–0.68 GB |

The index on disk keeps its `updatedAt` fields until a session is added or moves, as designed.

Reads are down about 30× and writes about 4×. CPU fell only about 20%, so parsing metadata was a small part of the daemon's CPU; the remaining ~12% is not file I/O and is not yet attributed.

## Open Issues

- **Writes are metadata saves.** Measured on galactica on 2026-11-10 (`v0.2.19`, 2,356 sessions): the daemon wrote 0.23–0.33 MB/s.
  - Polling the active sessions' metadata at 20 Hz found 152 replacements a minute, about 178 KB/s.
  - Each file is 60–97 KB, almost all `recentFingerprints`. A session whose transcript is growing gets saved up to every 2 seconds.
  - Twin appends were under 1 KB/s and `status.json` about 3 KB/s. Recording outputs were not written in the window.
  - Fixed-size fingerprint hashes would cut the saves about 10× but change persisted state, which needs a migration. Saving less often trades that cost for crash-recovery work.
- **CPU is discovery polling.** Measured the same day, with a V8 CPU profile over 180 seconds.
  - **Setup:** the daemon ran from source with `--inspect`, against a copy of the state in a temp `HOME`, with `--allow-write` limited to that copy. It used 10–14% of a core, like the installed one.
  - **Main thread:** JavaScript was busy only 4.4% of the time. About 40% of that was session discovery: `walkJsonlFiles`, `discoverCodexSessions`, `discoverClaudeSessions` and per-file stats. Another 12% was `ingestSession` with event merging.
  - **The rest** of the process CPU is the filesystem calls themselves, on Deno's worker threads, plus the waits that hand each one back. That is about 1,800 write and 2,900 read syscalls a second at under 200 bytes each.
  - **Cause:** discovery rewalks every provider root every 5 seconds (`DEFAULT_DISCOVERY_INTERVAL_MS`). The daemon also watches those roots, so most of the walk only confirms what the watcher already reported. On galactica that is 21 roots, about 4,100 directories and 2,600 transcripts, so each walk issues roughly 6,700 directory reads and stats.
  - **Options:** walk less often while the watcher is healthy; re-read only directories whose mtime changed, since that catches new files; or both, plus a periodic full walk for missed events. Any of these needs per-platform watcher checks (inotify, FSEvents, ReadDirectoryChangesW) before discovery can rely on the watcher.
  - **Planned** in [[task.2026.2026-11-10-watcher-led-discovery]].
- `listSessionMetadata()` still stats and clones every session's metadata (about 70 ms for 2,316 sessions) for Kato Web and CLI callers.
- Twin hydration still reads the whole twin once per session after start (see [[task.2026.2026-11-09-snapshot-sharing]]).

## Implementation Plan

- [x] Drop `updatedAt` from index entries; accept and normalize older entries; compare entries by identity and paths.
- [x] Read the cached index without cloning on read-only paths.
- [x] Status reads metadata for the snapshot store's sessions only; remove the summary cache and `sessionMetadataRefreshIntervalMs`.
- [x] Re-read listed metadata only when its file stamp changed; record stamps of the store's own writes.
- [x] Loop writes until complete (`writeAll`) for atomic writes and twin appends.
- [x] Tests (index writes, legacy index, stamp check, status keyed reads); fix the two tests that wrote the index to the wrong path.
- [x] `deno task ci`: 978 tests passed.
- [x] Release and verify on galactica (read and write rates, index rewrites): `v0.2.18`, see Verification.
