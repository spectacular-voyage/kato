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

# Summary

- rename snapshot-generation config to twin-generation config
- keep live provider ingestion and command detection independent from twin persistence
- make explicit twin actions mean what they say:
  - `create twin` replays provider source from the beginning and writes a full twin
  - `update twin` advances an existing twin, or falls back to `create twin` if it is missing
- make full-history `capture` / `export` work without twins by replaying provider source on demand
- keep recording continuation metadata-only; recording state alone should not force twin creation
- replace top-level web twin inventory terminology and routes without keeping `ingestion` as the primary user-facing concept

# Discussion

## Current Reality To Correct

- `globalAutoGenerateSnapshots` / `providerAutoGenerateSnapshots` do not currently gate provider parsing; they only affect snapshot/twin hydration behavior
- newly modified sessions after daemon start are proactively ingested even when auto-generate is false
- twin history is currently appended unconditionally whenever session state is enabled
- manual web ingestion currently resumes from `ingestCursor`, which is not sufficient to mean `create twin`
- CLI/control-plane export currently depends on the live in-memory snapshot loader, not provider-source replay
- restart recovery currently rebuilds missing in-memory snapshots from persisted twins, not from generic provider-source replay
- in-memory snapshots are already ephemeral; the daemon does not persist them across restarts
- recent web work expanded the rename surface beyond `/ingestion` and `/sessions`:
  - Summary
  - Workspaces backlinks
  - live JSON endpoints
  - app header/navigation
  - route builders and related tests

## Scenario Table

| Scenario                                                                                | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes                                                            |
| --------------------------------------------------------------------------------------- | ------------------ | ---------------------- | -------------- | --------------------------------------------------------------------------------------- |
| Auto-twin provider discovers a recently active session                                  | Yes                | n/a                    | Yes            | live ingestion, command detection, and persisted twin creation all continue             |
| Non-auto-twin provider discovers a recently active session with no explicit twin action | n/a                | Yes                    | Mostly         | live ingestion and command detection continue, but no twin is written                   |
| User chooses `create twin` for a session with no twin                                   | Yes                | n/a                    | n/a            | must replay provider source from start, not resume from stored ingest cursor            |
| User chooses `update twin` for a session with an existing twin behind source            | Yes                | n/a                    | n/a            | should advance the twin incrementally; missing twin falls back to `create twin`         |
| User runs `capture` / `export` for a session with no twin after daemon restart          | n/a                | Yes                    | Yes            | full-history replay comes from provider source instead of twin history                  |
| Session has active workspace recording state but no twin                                | n/a                | Yes                    | Yes            | recording continuation uses metadata plus live ingestion; twin creation is not required |

# Decisions

- rename `globalAutoGenerateSnapshots` to `globalAutoGenerateTwins`
- rename `providerAutoGenerateSnapshots` to `providerAutoGenerateTwins`
- do not support config compatibility for the old names
- daemon startup must fail fast with a clear error if either old config key is present
- keep runtime config schemaVersion at `1`; handle the old keys with a targeted validation error instead of a broader schema migration
- keep persisted session metadata across restarts
- stop persisting `snippet` in session metadata
- for legacy metadata that still contains `snippet`, ignore it for behavior and scrub it whenever metadata is rewritten
- twin persistence happens only when:
  - the new twin auto-generate setting is enabled for that provider, or
  - the user explicitly requests `create twin` / `update twin`
- `capture`, `export`, and recording continuation must not create a twin as an implicit side effect when one does not already exist
- transient in-memory provider ingestion remains enabled for command detection regardless of twin persistence settings
- when no twin exists, full-history capture/export must use on-demand provider source replay instead of relying on persisted twin history
- CLI/control-plane export must use the same replay fallback policy as in-chat capture/export
- degraded Codex timestamp fidelity during on-demand source replay is acceptable for non-auto-twin sessions
- `create twin` means replay from provider source start and write a full twin
- `update twin` means advance an existing twin; if the twin is missing or unusable, fall back to `create twin`
- workspace recording continuation across restart remains metadata-driven and does not require automatic twin creation
- `Sessions` remains the primary user-facing inventory of provider sessions
- the current top-level `Ingestion` page/tab is replaced by a `Twins` page focused on what conversation twins are actually persisted on disk
- keep `/ingestion` only as a short-lived compatibility redirect if it is low-cost; do not keep it as a primary nav concept
- the `Sessions` page should surface live activity / recording / twin state separately instead of collapsing them into a single "ingestion" concept
- manual user actions should use twin-specific language such as `create twin` / `update twin`, not `start ingestion` / `continue ingestion`
- raw ingestion state, if still exposed in the web app, belongs in a secondary debug/detail surface rather than top-level navigation
- `Twins` gets its own loader/API model instead of reusing `loadSessionsPageData()`
- internal telemetry event names are not required to change in this task unless a touched codepath naturally renames them

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
- web/runtime surfaces must tolerate missing persisted snippets and derive display text from:
  - live snapshot snippet first
  - twin-derived snippet when twins exist
  - on-demand provider-source snippet extraction when the route explicitly needs it
  - blank / placeholder text otherwise

## Twins

- twins become the persisted conversation log, not the default side effect of discovery
- Codex remains auto-twin by default via the new config defaults
- non-auto-twin providers only persist twins when explicitly activated by user intent

## Web UI

- `Sessions` remains the main inventory page for provider sessions discovered from provider source files
- `Sessions` should show separate signals for:
  - current live activity / snapshot presence
  - recording state
  - twin persistence state
- do not use `not ingested` as a catch-all label when the real state is "no twin", "not currently active", or "no persisted history"
- the current top-level `Ingestion` page should be replaced by a `Twins` page that answers:
  - which sessions currently have twins
  - where those twin files live
  - whether the twin is current or behind the provider source
  - what explicit user action is available (`create twin` / `update twin`)
- Summary should stop using `Ingestion` as the primary label for persisted-history state and should link to `Sessions` / `Twins` using the new semantics
- Workspaces and other backlinks should point to `Sessions` or `Twins` intentionally instead of assuming `/ingestion`
- the web app should expose:
  - `/twins`
  - `/api/twins`
- any remaining ingestion-specific diagnostics should move to a secondary debug/detail view rather than being a top-level user concept

## Restart / Replay

- if a session has twins, restart behavior remains essentially the same: rebuild snapshot state from twin plus resumed ingestion cursor
- if a session does not have twins:
  - restart still restores metadata and cursors
  - active workspace output continuation can still resume from metadata
  - full-history `capture` / `export` must reconstruct events by reparsing the provider source file on demand
- do not add persisted snapshot files; keep snapshots memory-only

# Open Issues

- No blocking open issues remain once the decisions above are treated as authoritative.
- If `/ingestion` compatibility redirects prove noisy in Fresh/Vite routing, drop them and update internal links/tests in the same change instead of preserving a second route model.

# Contract Changes

- `RuntimeConfig`
  - rename `globalAutoGenerateSnapshots` to `globalAutoGenerateTwins`
  - rename `providerAutoGenerateSnapshots` to `providerAutoGenerateTwins`
- shared runtime/web helpers
  - replace `providerAutoGeneratesSnapshots(...)`-style naming with twin-specific naming
- `SessionMetadataV1`
  - remove durable `snippet`
  - retain ingest cursor/anchor and workspace output state regardless of twin presence
- web route/API contracts
  - replace `/ingestion` / `/api/ingestion` as primary concepts with `/twins` / `/api/twins`
  - introduce twin-specific row/action models instead of overloading session-ingestion state

# Implementation Plan

## 1. Config and Naming

- [x] replace the runtime config contract, parser, defaults, tests, and any web/runtime references from `*AutoGenerateSnapshots` to `*AutoGenerateTwins`
- [x] reject startup if the old keys are present in config, with an explicit error telling the user to rename them
- [x] preserve the current default product intent by defaulting `providerAutoGenerateTwins.codex = true`

## 2. Runtime Ingestion Split

- [x] change provider ingestion so background parsing into in-memory snapshots is independent from twin persistence
- [x] keep proactive discovery/ingestion for new-ish sessions after daemon start
- [x] gate `appendTwinEvents()` and twin bootstrap/hydration decisions behind the new twin-persistence policy instead of unconditional `shouldAppendTwin = true`
- [x] ensure metadata cursor updates still happen when twins are off, so command detection and restart cursor continuity continue to work

## 3. Source Replay Fallback

- [x] add a provider-source replay helper that can parse a session from the beginning on demand
- [x] use that helper for `capture` / `export` when:
  - there is no usable twin history, and
  - full-history boundary reconstruction is needed
- [x] use the same helper for CLI/control-plane export session resolution when no live snapshot or no twin-backed history is available
- [x] keep current twin-backed replay when twins exist
- [x] for Codex, document that replayed historical events may have less-accurate timestamps than auto-twin/live-captured events

## 4. Metadata and Privacy Cleanup

- [x] remove `snippet` from the metadata contract and stop writing it during provider ingestion and manual twin actions
- [x] update session-state store cloning / validation / tests accordingly
- [x] add rewrite-time scrubbing so legacy `snippet` values are dropped whenever metadata is saved
- [x] clarify `cleanSessionStatesOnShutdown` semantics:
  - still remove twin files
  - do not rely on shutdown cleanup for snippet privacy because snippets should no longer be persisted at all

## 5. Web / Status / Navigation Semantics

- [x] add a dedicated twin loader/API instead of reusing `loadSessionsPageData()` for persisted-history views
- [x] update web loaders so "ingested" / "idle" state is no longer inferred from raw twin existence alone
- [x] make `Sessions` the primary inventory of provider sessions
- [x] add explicit session-level UI signals for live activity, recording engagement, and twin persistence instead of collapsing them into one status label
- [x] replace the current top-level `Ingestion` page/tab with a `Twins` page
- [x] make the `Twins` page show, per session:
  - twin present / absent
  - twin file path
  - whether the persisted twin is current or behind the provider source
  - a twin-focused action (`create twin` or `update twin`) when applicable
- [x] rename manual web actions from `start ingestion` / `continue ingestion` to `create twin` / `update twin`
- [x] update Summary / Workspaces / route builders / live JSON endpoints so user-facing terminology and links match the new model
- [x] if raw ingestion diagnostics remain useful, move them to a secondary debug/detail view rather than top-level navigation
- [x] session pages should continue to use live snapshot state for active ingestion
- [x] inventory pages should not assume a persisted snippet exists
- [x] where snippet is absent and there is no live/twin/source-derived fallback, render a neutral placeholder rather than fabricating one

## 6. Documentation

- [x] update `dev.general-guidance`
- [x] update `dev.codebase-overview`
- [x] update `dev.decision-log`
- [ ] update `dev.testing` if validation counts/timings materially changed

# Acceptance Criteria

- starting the daemon with `globalAutoGenerateSnapshots` or `providerAutoGenerateSnapshots` present fails immediately with a clear config error
- with `providerAutoGenerateTwins.claude = false`, a new Claude session can still be live-ingested for command detection without creating a twin file
- with `providerAutoGenerateTwins.codex = true`, a new Codex session still persists twins automatically
- after daemon restart, a non-twin session can still execute full-history `capture` / `export` by reparsing provider source
- `kato export <session>` works for a non-twin persisted session after daemon restart by using the same provider-source replay fallback policy
- workspace-bound recording continuation across restart still works without requiring automatic twin creation
- choosing `create twin` for a session with no twin replays provider source from the beginning instead of resuming from `ingestCursor`
- choosing `update twin` for an existing twin advances the persisted twin incrementally, and missing twin state falls back cleanly to `create twin`
- persisted session metadata files do not contain `snippet`
- the `Sessions` page remains the primary provider-session inventory and does not use `not ingested` as a synonym for `no twin`
- the top-level `Twins` page shows persisted twin presence/state/path and twin-focused actions
- Summary / Sessions / Twins / Workspaces navigation and API routes use the new terminology consistently
- web Sessions / Twins / Recordings / Workspaces continue to function when persisted metadata lacks snippets

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
  - CLI/control-plane export source replay when no twin exists
  - restart continuity for workspace output append with metadata-only sessions
- session state store / web loader tests for:
  - no persisted snippet
  - legacy snippet ignored/scrubbed
  - UI behavior without metadata snippets
  - `Sessions` page state/badge behavior when live activity and twin presence diverge
  - `Twins` page presence/currentness/action behavior
  - Summary / Workspaces / live route behavior after `/twins` rename and snippet fallback changes

# Non-Goals

- preserving backward compatibility for the old config names
- adding a persisted snapshot file format
- perfect historical timestamp reconstruction for Codex sessions that are not auto-twinned
