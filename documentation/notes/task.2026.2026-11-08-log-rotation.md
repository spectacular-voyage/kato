---
id: m3k8w1rq5tz0yb7hvn2xcfa
title: Log Rotation
desc: Daily rotation and age-based retention for Kato's JSONL operational and security-audit logs.
updated: 1794175200000
created: 1794175200000
---

## Goal

Keep Kato's JSONL logs bounded on disk without operator intervention: rotate daily, discard rotated logs after a configurable number of days (default 30).

## Summary

`~/.kato/daemon/logs/security-audit.jsonl` reached 583 MB (724k lines over ~36 days) on galactica because nothing ever rotates or prunes it. The same unbounded growth applies to every `JsonLineFileSink` log (daemon, CLI, and web; operational and security-audit). Rotation is implemented once, in `JsonLineFileSink`, so every Kato log gets it.

## Discussion

- Every Kato log is written through `JsonLineFileSink`, which opens, appends, and closes the file per record. Because no process holds the file open, renaming the active file aside is safe: the next write by any writer simply creates a fresh active file.
- Keeping the active filename stable (`security-audit.jsonl`) preserves every existing reader: the Kato Web log viewer (tails the active file), `kato status` recent errors, `kato clean --logs`, documentation, and operators running `tail -F`.
- Rotated files are named by the UTC day of their last write: `security-audit.2026-11-07.jsonl`. Record timestamps are UTC ISO strings, so UTC day boundaries keep file names consistent with record contents. Naming by last-write day gives correct retention semantics: a file is discarded only once everything in it is older than the retention window.
- Rollover is detected lazily on write (no timers): when the current UTC day differs from the day the sink last observed, the sink stats the active file and rotates it only if its mtime day is earlier than today. The mtime check prevents a second sink instance (or a second process) from rotating a file another writer already rotated today.
- Pruning runs after each rollover check (at most once per UTC day per sink instance, plus first write) and deletes only files matching the rotated-name pattern for that log whose day is older than `today - retentionDays`. The active file is never pruned.
- Rotation and pruning are best-effort: a failure never blocks or fails the log write; the record is still appended to the active file.
- The existing 583 MB legacy file will be rotated at the first UTC day change after upgrade and then pruned 30 days later. It is not split by record date.

## Open Issues

- The web app has no logging config, so web logs use the default retention. Add `logging.retentionDays` to web config only if someone needs it.
- The Kato Web log viewer reads only the active file, so right after a UTC midnight it shows little history. Reading across rotated files is a possible follow-up.
- Audit volume itself (~99% `policy.decision` allow records for routine recording writes) is unchanged by this task. Rotation bounds disk use (~30 × daily volume); reducing allow-decision volume is a separate decision about audit completeness.
- The exports log (`resolveExportsLogPath`) is a different writer and is out of scope.

## Decisions

- Rotation lives in `JsonLineFileSink` and is on by default with `DEFAULT_LOG_RETENTION_DAYS = 30`; callers pass `retentionDays` from config where config exists.
- New optional config key `logging.retentionDays` (positive integer, days) in the shared `RuntimeLoggingConfig`, accepted by daemon config (`kato-daemon-config.yaml`) and CLI config (`kato-cli-config.yaml`). Omitted means 30. Invalid values fail config load, consistent with existing fail-closed logging validation. The key is optional so existing configs and serialized defaults are unchanged.
- One retention value applies to both operational and security-audit logs of a given app.
- Rotated name: `<stem>.<YYYY-MM-DD>.jsonl`; on collision, `<stem>.<YYYY-MM-DD>.<n>.jsonl`. Rotation never overwrites an existing file.
- In-process rollover for a given path is serialized so concurrent sink instances for the same file do not race each other.
- `kato clean --logs` / `--all` also deletes rotated files for the logs it flushes, reported as `logsDeleted` / `logsToDelete`.

## Contract Changes

- `RuntimeLoggingConfig` gains optional `retentionDays?: number`.
- `JsonLineFileSink` constructor gains an optional options argument: `{ retentionDays?: number; now?: () => Date }`.
- `MaintenanceCleanStats` gains `logFilesDeleted` and `logFilesWouldDelete`; the clean summary gains `logsDeleted=` / `logsToDelete=` when nonzero.
- New on-disk artifacts: rotated `*.YYYY-MM-DD[.n].jsonl` files next to each active log.

## Testing

- Same-day writes stay in the active file.
- A UTC day change rotates the active file to `<stem>.<previous-day>.jsonl` and writes the new record to a fresh active file.
- A pre-existing active file with an older mtime is rotated on first write, named by its mtime day.
- Name collision yields a `.1` suffix; nothing is overwritten.
- Pruning removes rotated files older than the window, keeps the boundary day, ignores unrelated files and other logs' rotated files, and never removes the active file.
- Concurrent sink instances writing the same path across a day change lose no records.
- Daemon and CLI config accept a valid `retentionDays`, reject `0`, negatives, non-integers, and strings, and keep rejecting unknown logging keys.
- `runMaintenanceClean({ all: true })` deletes rotated files (and only reports them in dry-run).

## Non-Goals

- Size-based rotation, compression, or shipping logs elsewhere.
- Changing audit event volume.
- Rotating the exports log.

## Implementation Plan

- [x] Add rotation helpers and `JsonLineFileSink` rollover/prune with per-path serialization.
- [x] Add optional `logging.retentionDays` to `RuntimeLoggingConfig` and validate it in daemon and CLI config parsers.
- [x] Wire `retentionDays` into daemon and CLI sinks; web uses the default.
- [x] Extend `kato clean --logs` to delete rotated log files.
- [x] Tests for rotation, pruning, concurrency, config validation, and clean.
- [x] Update [[user-guide.configuration]], [[user-guide.troubleshooting]], [[dev.codebase-overview]], and [[dev.decision-log]].
- [x] Add to next release notes ([[release-notes.v0.2.16]]).
- [x] `deno task fmt`, `deno task lint`, `deno task check`, and the affected tests.
