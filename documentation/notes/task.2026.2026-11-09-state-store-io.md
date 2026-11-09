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

## Open Issues

- Each save of an active session's metadata writes and fsyncs about 100 KB, almost all `recentFingerprints`. Fixed-size hashes would cut that about 10× but change persisted state (needs a migration).
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
- [ ] Release and verify on galactica (read and write rates, index rewrites).
