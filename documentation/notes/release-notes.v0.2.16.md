---
id: sbflq43qghaoizde0d2dr688
title: 'Release Notes v0.2.16'
desc: Incremental transcript parsing, visible ingestion failures, recordings that no longer drop content after restarts or in long conversations, session twins on by default, startup catch-up, and log rotation.
updated: 1794199799901
created: 1794199799901
---

## Summary

`v0.2.16` fixes a daemon that could pin a CPU core indefinitely and stop capturing large conversations.

Every time a conversation transcript grew, the daemon re-read and re-parsed the whole file from the beginning. With multi-gigabyte Codex rollouts this kept one thread at 100% and, past 512 MiB, failed outright with an out-of-memory parse error that was retried every second and never surfaced anywhere but the logs. Transcripts are now streamed and resumed from where the last read stopped, so each update costs roughly the size of what was appended. On a machine with about 21 GB of Codex rollouts the daemon dropped from 94% of a core and 2.4 GB of memory to about 12% and 350 MB.

When reading a conversation does fail, it is no longer silent: Kato Web and `kato status` show which conversations are not being captured and why. Conversations that kept going while the daemon was stopped, or while it could not read them, are now caught up after the daemon starts instead of waiting for their next message.

Recordings stopped losing content. A recording remembered how far it had written as a position in the daemon's in-memory event list, which is rebuilt on every daemon start and keeps only a conversation's newest 10,000 events. So the first batch of new content after each restart was silently skipped, and once a conversation passed 10,000 events its recording stopped growing altogether. Each recording now remembers the transcript position of the last content it wrote, which survives restarts and long conversations.

Session twins (Kato's normalized copy of each conversation) are now on by default for new installs, so the daemon can rebuild a conversation's recent history after a restart.

Kato's logs now rotate daily and are discarded after 30 days by default.

## User-facing Changes

- Large transcripts no longer cause sustained high CPU or "failed to allocate string" parse errors; transcripts of any size are captured.
- Conversations Kato cannot read are listed with their error: a failure count on the Kato Web Summary, an "ingestion failing since …" badge on the matching Sessions row, and a section in `kato status`. Failing conversations are retried with backoff (30 s doubling to 15 min) and clear automatically once readable.
- After `kato start`, conversations Kato was already tracking that gained content while it was not running are caught up one at a time, most recent first, and the missed content is appended to any recordings that are on. A large backlog can keep the daemon busy for a minute or two; see [[user-guide.troubleshooting]].
- Recordings no longer skip the first content after a daemon restart and no longer stop once a conversation exceeds 10,000 events. If content does fall out of memory before it can be written (for example a very large backlog), the daemon logs `recording.append.gap` instead of failing silently.
- Session twins are on by default (`globalAutoGenerateTwins: true`) in newly created daemon configs; see [[user-guide.configuration#session-twins]].
- Operational and security-audit logs rotate daily to files such as `security-audit.2026-11-07.jsonl` and are deleted after 30 days. Set `logging.retentionDays` in the daemon or CLI config to change it; see [[user-guide.configuration#logs]]. `kato clean --logs` also removes rotated files.
- Lower steady-state disk reads: Codex session discovery no longer re-reads every rollout every few seconds, and the daemon no longer reloads all session metadata every second.

### Upgrade notes

- Existing daemon configs that contain `globalAutoGenerateTwins: false` keep it; Kato's generated configs have always written that line, so set it to `true` to turn twins on. Each conversation then rebuilds its twin from its transcript on its next update, a one-time full read per conversation, and twins take disk space under `~/.kato/shared/sessions/`.
- Recordings written by earlier versions switch to the new position tracking on their next update. Content that arrived after a recording's last write and is still in memory is appended then; older losses in the middle of a recording cannot be restored.
- Session metadata gains an optional per-recording `writeSourceCursor`. Older binaries ignore it and drop it on their next rewrite.
- No config migration. `logging.retentionDays` is optional; older binaries reject configs that contain it (configs fail closed on unknown keys), so remove it before downgrading.
- An existing oversized `security-audit.jsonl` is rotated at the first UTC day change after upgrade and deleted 30 days later. It is not split by date.
- The first daemon start after upgrading may catch up a large backlog left by earlier parse failures.
- After any restart, each active Codex conversation pays one full read of its rollout on its first update; parser resume state is kept in memory only.

## Developer-oriented Changes

- New shared byte-level JSONL reader (`apps/daemon/src/utils/jsonl_line_reader.ts`) used by the Claude and Codex parsers and the Codex compaction scan: seeks to an offset, scans chunks for newlines, decodes complete lines only, and reports byte offsets. No transcript-sized strings are built.
- Claude parsing is seek-and-stream from the cursor. Codex parsing is a resumable state machine (`CodexParserState`) with an in-memory resume cache per session, guarded by a hash of the bytes before each resume offset so in-place rewrites fall back to a full pass. The compaction anchor scan is incremental.
- Fixed a Codex parser path dependence where the events produced depended on the starting offset.
- Per-session parse-failure backoff, with `provider.ingestion.parse_error` logged on the first failure and each escalation (with `consecutiveFailures`, `nextRetryAt`) instead of every attempt. `DaemonStatusSnapshot` gains optional `ingestionFailures`.
- Codex discovery memoizes each rollout's first-line `session_meta` by path and inode (`CodexSessionMetaCache`).
- `PersistentSessionStateStore.listSessionMetadataForKeys()` reads only the requested sessions; per-poll daemon paths use it, and the full listing runs only at heartbeat, exit, and control-request time.
- Startup catch-up: newly discovered tracked sessions whose source mtime is newer than `lastObservedMtimeMs` and, for byte-offset cursors, whose size differs from the cursor are queued and drained one per poll (`provider.ingestion.catch_up.queued`).
- Workspace outputs persist `writeSourceCursor` (the `rawCursor` of the last written event). `resolveWorkspaceOutputWriteStart` resumes after the last snapshot event at or before it; outputs without one migrate once by the active cycle's `lastWriteAt` (only when `writeCursor > 0`, so auto-record still writes the whole conversation), then fall back to the clamped index. Daemon command paths and Kato Web recording actions set the position through `setWorkspaceOutputWritePosition`, and merge-before-save keeps the furthest position.
- `DEFAULT_GLOBAL_AUTO_GENERATE_TWINS = true` in `@kato/shared`, used by config parsing, default config creation, the ingestion runner factory, and Kato Web.
- `JsonLineFileSink` rotates on UTC day change and prunes rotated files past `retentionDays` (`DEFAULT_LOG_RETENTION_DAYS = 30`), best-effort and serialized per path; `RuntimeLoggingConfig` gains optional `retentionDays`.
- `apps/web/deno.lock`: cleared 13 `deno audit` advisories (6 high) with in-range bumps — vite 7.3.7 (floor raised to `^7.3.7`), esbuild 0.28.2, browserslist 4.29.5, nanoid 3.3.20, source-map-js 1.2.2, baseline-browser-mapping 2.11.35, @babel/core 7.29.13.
