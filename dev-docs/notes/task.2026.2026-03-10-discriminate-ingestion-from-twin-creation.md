---
id: kmpbihvnd51vhbyjpvchi8r
title: 2026 03 10 Discriminate Ingestion from Twin Creation
desc: ''
updated: 1773204824855
created: 1773204824855
---

# Goal

Separate three concepts that are currently conflated:

- provider ingestion into the daemon's in-memory snapshot store
- persisted session metadata
- persisted twin event history

The desired model is:

- all new-ish provider sessions may still be ingested into in-memory snapshots so Kato can detect in-chat commands in near real time
- persisted metadata remains available across daemon restarts
- persisted twin history is opt-in, controlled by new twin-specific config flags

The privacy goal is that Kato should not automatically persist every conversation transcript by default. The product goal is still that Codex can auto-persist twins by default so accurate realtime timestamps are preserved when users want always-on capture behavior there.

# Current Reality To Correct

- `globalAutoGenerateSnapshots` / `providerAutoGenerateSnapshots` do not currently gate provider parsing; they only affect snapshot/twin hydration behavior.
- newly modified sessions after daemon start are proactively ingested even when auto-generate is false
- twin history is currently appended unconditionally whenever session state is enabled
- restart recovery currently rebuilds missing in-memory snapshots from persisted twins, not from generic provider-source replay
- in-memory snapshots are already ephemeral; the daemon does not persist them across restarts

# Decisions

- rename `globalAutoGenerateSnapshots` to `globalAutoGenerateTwins`
- rename `providerAutoGenerateSnapshots` to `providerAutoGenerateTwins`
- do not support config compatibility for the old names
- daemon startup must fail fast with a clear error if either old config key is present
- keep persisted session metadata across restarts
- stop persisting `snippet` in session metadata
- for legacy metadata that still contains `snippet`, ignore it for behavior and scrub it on write / maintenance paths
- twin persistence happens only when:
  - the new twin auto-generate setting is enabled for that provider, or
  - the session has explicit user intent that requires persistence, such as manual ingestion or workspace-bound recording state that depends on twin history
- transient in-memory provider ingestion remains enabled for command detection regardless of twin persistence settings
- when no twin exists, full-history capture/export must use on-demand provider source replay instead of relying on persisted twin history
- degraded Codex timestamp fidelity during on-demand source replay is acceptable for non-auto-twin sessions

# Target Behavior

## Ingestion

- provider runners continue to discover sessions, parse new events, and update the in-memory `SessionSnapshotStore`
- this remains the mechanism for:
  - live status
  - near-realtime command detection
  - active recording append behavior during the current daemon run

## Metadata

- `SessionMetadataV1` remains the durable store for:
  - stable Kato session id
  - source file path
  - ingest cursor / ingest anchor
  - command cursor / command anchor
  - workspace output bindings
  - recording cycles
  - twin path / next sequence / fingerprint state when twins are in use
- `snippet` is removed from the durable metadata contract
- web inventory pages must tolerate missing persisted snippets and derive display text from:
  - live snapshot snippet first
  - twin-derived snippet when twins exist
  - on-demand provider-source snippet extraction when the route explicitly needs it
  - blank / placeholder text otherwise

## Twins

- twins become the persisted conversation log, not the default side effect of discovery
- Codex remains auto-twin by default via the new config defaults
- non-auto-twin providers only persist twins when explicitly activated by user intent

## Restart / Replay

- if a session has twins, restart behavior remains essentially the same: rebuild snapshot state from twin plus resumed ingestion cursor
- if a session does not have twins:
  - restart still restores metadata and cursors
  - active workspace output continuation can still resume from metadata
  - full-history `capture` / `export` must reconstruct events by reparsing the provider source file on demand
- do not add persisted snapshot files; keep snapshots memory-only

# Implementation Plan

## 1. Config and Naming

- replace the runtime config contract, parser, defaults, tests, and any web/runtime references from `*AutoGenerateSnapshots` to `*AutoGenerateTwins`
- reject startup if the old keys are present in config, with an explicit error telling the user to rename them
- preserve the current default product intent by defaulting `providerAutoGenerateTwins.codex = true`

## 2. Runtime Ingestion Split

- change provider ingestion so background parsing into in-memory snapshots is independent from twin persistence
- keep proactive discovery/ingestion for new-ish sessions after daemon start
- gate `appendTwinEvents()` and twin bootstrap/hydration decisions behind the new twin-persistence policy instead of unconditional `shouldAppendTwin = true`
- ensure metadata cursor updates still happen when twins are off, so command detection and restart cursor continuity continue to work

## 3. Source Replay Fallback

- add a provider-source replay helper that can parse a session from the beginning on demand
- use that helper for `capture` / `export` when:
  - there is no usable twin history, and
  - full-history boundary reconstruction is needed
- keep current twin-backed replay when twins exist
- for Codex, document that replayed historical events may have less-accurate timestamps than auto-twin/live-captured events

## 4. Metadata and Privacy Cleanup

- remove `snippet` from the metadata contract and stop writing it during provider ingestion and manual ingestion
- update session-state store cloning / validation / tests accordingly
- add a startup or maintenance scrub that drops legacy `snippet` values from existing metadata files when they are rewritten
- clarify `cleanSessionStatesOnShutdown` semantics:
  - still remove twin files
  - do not rely on shutdown cleanup for snippet privacy because snippets should no longer be persisted at all

## 5. Web / Status Semantics

- update web loaders so "ingested" / "idle" state is no longer inferred from raw twin existence alone
- session pages should continue to use live snapshot state for active ingestion
- inventory pages should not assume a persisted snippet exists
- where snippet is absent and there is no live/twin/source-derived fallback, render a neutral placeholder rather than fabricating one

# Acceptance Criteria

- starting the daemon with `globalAutoGenerateSnapshots` or `providerAutoGenerateSnapshots` present fails immediately with a clear config error
- with `providerAutoGenerateTwins.claude = false`, a new Claude session can still be live-ingested for command detection without creating a twin file
- with `providerAutoGenerateTwins.codex = true`, a new Codex session still persists twins automatically
- after daemon restart, a non-twin session can still execute full-history `capture` / `export` by reparsing provider source
- workspace-bound recording continuation across restart still works without requiring automatic twin creation
- persisted session metadata files do not contain `snippet`
- web Sessions / Ingestion / Recordings / Workspaces continue to function when persisted metadata lacks snippets

# Tests

- runtime config tests for:
  - new key parsing
  - Codex default true
  - daemon-start failure on old keys
- provider ingestion tests for:
  - no twin append when auto-twin is off and no explicit persistence trigger exists
  - twin append when auto-twin is on
  - metadata cursor continuity without twins
- daemon runtime tests for:
  - first-seen command detection still working without twins
  - full-history `capture` / `export` source replay when no twin exists
  - restart continuity for workspace output append with metadata-only sessions
- session state store / web loader tests for:
  - no persisted snippet
  - legacy snippet ignored/scrubbed
  - UI behavior without metadata snippets

# Non-Goals

- preserving backward compatibility for the old config names
- adding a persisted snapshot file format
- perfect historical timestamp reconstruction for Codex sessions that are not auto-twinned
