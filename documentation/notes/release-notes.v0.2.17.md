---
id: diq5696q4b6m7ma8cs0kojyg
title: 'Release Notes v0.2.17'
desc: Daemon CPU and memory no longer grow with conversation length when session twins are on; macOS arm64 archives are attached to GitHub Releases again.
updated: 1794238759449
created: 1794238759449
---

## Summary

`v0.2.17` fixes high daemon CPU and memory use with long conversations, which `v0.2.16` made common by turning session twins on by default.

With twins on, the daemon keeps each active conversation's most recent 10,000 events in memory. Every time a conversation changed, the daemon copied and re-serialized all of those events several times, so each update to a long conversation cost about a quarter of a second of CPU, and the cost added up across every active conversation. On a machine with about 25 active conversations, `v0.2.16` used 35–48% of a core and 1.0–1.5 GB of memory, rising as more conversations became active. Updates now cost roughly the size of what was added: the same work takes about 2 ms instead of 260 ms.

GitHub Releases include the macOS arm64 archive again; `v0.2.15` and `v0.2.16` were published without it.

## User-facing Changes

- Lower steady-state CPU and memory for the daemon when conversations are long, especially with session twins on.
- The daemon no longer rewrites its session index file (`~/.kato/shared/daemon-control.json`) on every metadata save; it is rewritten only when a session's entry changes.
- The GitHub Release includes `kato-v<version>-macos-arm64.tar.gz` and its checksum. (`v0.2.16`'s was attached by hand; `v0.2.15` still lacks it.)

### Upgrade notes

- No config or data migration.
- The first minutes after a restart still include the one-time work described in [[release-notes.v0.2.16]]: catching up conversations that changed while the daemon was stopped, one full read of each active Codex rollout, and loading each active conversation's history from its twin.

## Developer-oriented Changes

- `InMemorySessionSnapshotStore` holds sealed events (`apps/daemon/src/orchestrator/sealed_events.ts`): each incoming event is copied once, deep-frozen, and shared by reference across `get()`, `list()`, and `upsert()`, which return their own events array, cursor, and metadata. Mutating a stored event now throws a `TypeError` instead of editing a private copy.
- The snapshot memory estimate memoizes each sealed event's JSON byte size and still equals `utf8ByteLength(JSON.stringify(snapshot))`.
- `mergeEvents` and the daemon runtime's event signatures are memoized per sealed event (per merge option combination).
- `PersistentSessionStateStore.saveSessionMetadata` uses `ensureDaemonControlEntry`, so the control index is rewritten only when the entry differs.
- `release-manual.yml` downloads the macOS arm64 bundle by name into its own directory; a lone artifact matched by `pattern` was extracted straight into the parent directory, where release metadata preparation never looked.
- See [[task.2026.2026-11-09-snapshot-sharing]] and [[dev.decision-log]].
