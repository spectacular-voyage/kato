---
id: a2ng0gk9c8zqmae2uaoth5ai
title: 'Release Notes v0.2.18'
desc: The daemon stops re-reading every session's metadata and rewriting its session index while conversations are active, cutting its steady file I/O and the CPU spent parsing it.
updated: 1794267382113
created: 1794267382113
---

## Summary

`v0.2.18` removes most of the daemon's remaining steady-state file activity.

After `v0.2.17`, a daemon with about 2,300 known sessions and a few dozen active ones still read about 4.4 MB/s and wrote about 1 MB/s, while the conversations themselves were growing by about 0.013 MB/s. Nearly all of it was the daemon re-reading its own per-session metadata files: every status heartbeat (about every 5 seconds) read every session's file, and every poll re-read the active sessions' files to pick up changes made in Kato Web. The reads came from the operating system's cache rather than disk, so the cost was CPU spent parsing JSON. The writes came from the session index (`~/.kato/shared/daemon-control.json`), which was rewritten and synced to disk on almost every update because each entry carried a timestamp that changed.

Now a metadata file is read again only when it has changed, the heartbeat reads only the active sessions' metadata, and the session index is rewritten only when a session is added or its files move. On a copy of a 2,300-session state, a poll's metadata read went from about 8 ms to 1 ms, a heartbeat's from about 100 ms to 1 ms, and a metadata save from about 1.8 MB written to about 100 KB.

## User-facing Changes

- Lower steady-state daemon CPU and file I/O, especially with many known sessions. Status output is unchanged.
- The session index is rewritten only when a session is added or its files move. (`v0.2.17` set out to do this, but every update still changed the entry.)
- Changes made in Kato Web are still picked up by the daemon on its next poll.

### Upgrade notes

- No config or data migration. Index files written by earlier versions load as before.
- Downgrading to `v0.2.17` or earlier makes that daemon rebuild the session index once on start, by scanning `~/.kato/shared/sessions/`.

## Developer-oriented Changes

- `DaemonControlSessionIndexEntryV1` drops `updatedAt`. `isDaemonControlIndexV1` accepts entries with or without it, entries are normalized on load, and the field disappears on the next rewrite. Schema version stays 1.
- `PersistentSessionStateStore` re-reads a listed metadata file only when its inode, size, or mtime differs from the copy it last read or wrote. Atomic writes return the temp file's `stat`, which the rename preserves. On Windows `ino` is the volume file index, which the rename also replaces; if a platform reports no inode or mtime, the file is always re-read.
- Read-only index lookups use the cached index directly instead of cloning every entry.
- Atomic writes and twin appends loop until every byte is written (`writeAll`); a short `FsFile.write` previously went unnoticed.
- The daemon runtime's status reads metadata with `listSessionMetadataForKeys` for the snapshot store's sessions. The summary cache and `DaemonRuntimeLoopOptions.sessionMetadataRefreshIntervalMs` are removed.
- Two session-state-store tests wrote their corrupt and stale indexes to a path the store never reads, so index rebuild and healing were untested; they now use `resolveDefaultDaemonControlIndexPath()`.
- See [[task.2026.2026-11-09-state-store-io]] and [[dev.decision-log]].
