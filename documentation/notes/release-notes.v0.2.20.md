---
id: vk3x7n18dzzcxlfh4sado700
title: 'Release Notes v0.2.20'
desc: The daemon relies on its file watcher to find new and changed sessions instead of rescanning every provider directory every 5 seconds, and user messages with backslashes keep their italics.
updated: 1794544078807
created: 1794544078807
---

## Summary

`v0.2.20` removes most of the CPU the daemon spent looking for sessions.

Until now the daemon walked every configured provider directory every 5 seconds to find new and changed transcripts, and it walked all of them again whenever its file watcher reported a file it didn't already know about. With dozens of active agents writing under those directories, that happened nearly all the time. On a machine with 26 provider roots, finding and watching sessions took about 9.4% of a CPU core.

Now the file watcher drives discovery. A reported file is checked on its own, and a full walk of a directory happens every 5 minutes as a safety net. Sessions changed in the last 10 minutes are still checked directly every 5 seconds, so an active conversation never depends on the watcher alone. If those checks keep finding changes the watcher never reported, Kato stops trusting the watcher for that directory and walks it every 5 seconds again. Measured on the same machine with the same roots, discovery and watching dropped to about 0.9% of a core, and the daemon's write system calls for it fell by 99%.

This release also fixes italics in user messages that contain backslashes.

## User-facing Changes

- **Lower daemon CPU.** Discovery no longer rewalks every provider directory every 5 seconds. Status output and recordings are unchanged.
- **New status section.** When Kato stops trusting the watcher for a directory, `kato status` shows a "Watcher Degraded" section that names the provider, the reason (the watcher is down and restarting, or it missed changes), and the affected directories, which are then rescanned every few seconds. The section disappears once the watcher recovers; a directory marked for missed changes stays marked until the daemon restarts.
- **The watcher restarts itself.** A watcher that failed used to stay stopped until the daemon restarted. It now restarts after 5 seconds, then 30 seconds, then every 5 minutes, and directories are rescanned every 5 seconds while it is down.
- **Clearer watcher failures.** When Linux's inotify limits stop the watcher, the `provider.ingestion.watch.failed` log entry now says which limit to raise (`fs.inotify.max_user_watches` or `fs.inotify.max_user_instances`).
- **Dropped events are handled.** When the operating system reports that it dropped file events, Kato rescans every directory instead of ignoring the report.
- **Late provider directories are watched.** A provider directory created after the daemon started used to stay unwatched until a restart. It is now watched once it appears.
- **Italic user messages with backslashes.** A user message line that ended in a backslash, such as `C:\temp\`, lost its italics, and `\*`, `\_`, `\#` or `` \` `` in a message lost the backslash. Backslashes are now escaped only where Markdown would read them as escapes, so Windows paths and `\n` stay as typed. Existing transcripts are not rewritten.

### Upgrade notes

- No config or data migration.
- Some filesystems, such as network drives and Windows drives mounted in WSL, don't report changes to the watcher. On those:
  - sessions Kato already tracks that changed in the last 10 minutes are still picked up within 5 seconds;
  - a new session, or an older one that resumes, can take up to 5 minutes to appear;
  - once Kato notices the missed changes, it marks the directory degraded and rescans it every 5 seconds, as before, until the daemon restarts.
- pnpm 11 and later wait 24 hours before installing a new release, so `pnpm add -g @spectacular-voyage/kato@latest` installs `v0.2.19` on release day. The README explains how to install the exact version instead.

## Developer-oriented Changes

- **Watcher-led discovery** ([[task.2026.2026-11-10-watcher-led-discovery]]):
  - Each provider root has its own discovery state. Trusted roots are walked every 5 minutes (`discoveryIntervalMs`, previously 5 seconds); unwatched, watcher-down and degraded roots every 5 seconds.
  - Each provider exports `describe*SessionFile`, shared by walks and watch events. Reported paths that aren't transcripts walk nothing.
  - A hot poll stats sessions modified in the last 10 minutes every 5 seconds. A change it finds that the watcher didn't report within a 3-second grace period counts as a miss; three misses in 10 minutes degrade the root until restart.
  - The watcher restarts with backoff, guarded by a generation counter. On macOS, symlinked roots are matched through their real paths; on Windows, path keys fold case.
  - `watchFsDebounced` sets `rescan: true` on a batch when the OS reports dropped events, and caps a batch's wait at 1 second (`maxWaitMs`), so steady writes can't postpone every event.
  - Gemini discovery caches each session file's parse by mtime and size, so unchanged files aren't read again on a walk.
  - The status snapshot gains `watchDegraded?: DaemonWatchDegradedStatus[]`, present only while a root is degraded; `readWatchDegraded()` filters malformed entries.
  - New log events: `provider.ingestion.watch.rescan`, `provider.ingestion.watch.restarted`, `provider.ingestion.watch.degraded`, and at debug level `provider.ingestion.watch.missed` and `provider.ingestion.discovery.walked`. `provider.ingestion.watch.failed` carries `retryInMs` and, when recognized, a `hint`.
  - New tests: runner-level discovery tests with an injected clock and fake watcher, and real-watcher integration tests that run in CI on Linux, macOS and Windows.
- **Kato Web preparation for leaving Fresh** ([[task.2026.2026-11-10-leave-fresh]], steps 1–3; no user-visible change):
  - A characterization suite drives the built Fresh server in-process with 138 steps covering pages, APIs, auth, guards, static files, and every POST form. `deno task test:web` now builds the app first.
  - `hashStringFNV1a` moves to `shared/src`, and a new test walks each island's import graph to keep server-only modules out of the browser bundles.
  - Page and form logic moves from `routes/` into `apps/web/pages` behind a Kato-owned `RouteContext`; the Fresh routes are thin adapters.
- `formatUserMessageContent` escapes a backslash only before ASCII punctuation or at the end of a line. This resolves code-scanning alert 1 (`js/incomplete-sanitization`).
- `deno task ci`: 998 root tests and 12 Kato Web tests pass.
