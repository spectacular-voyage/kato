---
id: u1po3b6gfaeflgb7yv6jz3r
title: 'Release Notes v0.2.3'
desc: ''
updated: 1773255352000
created: 1773255220074
---

# kato v0.2.3 (2026-03-11)

Privacy-and-maintenance release that separates live session ingestion from
persisted twin history, moves twin management out of primary navigation, and
hardens the new web/runtime flows around snippet reveal and cleanup.

## Highlights

- `Sessions` is now the live provider-session inventory, while persisted twin
  troubleshooting and cleanup now live under `Maintenance`.
- The top-level `Twins` page is gone; twin status, create/update actions, and
  per-row delete now live on the `Maintenance` page instead.
- Persisted metadata no longer stores snippets. Older sessions now use
  on-demand `show snippet` recovery, with revealed snippets cached locally for
  that operator afterward.
- `Recordings` now participates in the same snippet-reveal flow, so recording
  rows can recover snippets without reintroducing durable snippet storage.
- `kato clean --twins` now names the cleanup surface directly and supports an
  explicit `--delete-metadata` privacy option when twin metadata files should
  be removed too.

## Notable Behavior Updates

- Live provider ingestion and command detection now remain independent from
  whether Kato is persisting twin history for that provider/session.
- Manual twin actions now mean exactly what they say:
  - `create twin` replays from provider source start and writes a full twin
  - `update twin` advances an existing twin, or falls back to create if the
    twin is missing
- Full-history `capture` and `export` can now replay provider source on demand
  when no twin exists, instead of depending on persisted twin history.
- Maintenance twin rows now derive state from actual persisted twin condition
  (`current`, `behind source`, `no twin`) instead of from reused Sessions-page
  heuristics.
- Snippet reveal failures now degrade cleanly to `snippet unavailable` instead
  of surfacing replay/read errors through the web UI.
- Summary wording now reflects twin generation semantics more explicitly, using
  labels such as `generating`, `not generating`, and
  `No provider sessions are currently generating twins.`

## Upgrade Notes

- Config keys were renamed:
  - `globalAutoGenerateSnapshots` -> `globalAutoGenerateTwins`
  - `providerAutoGenerateSnapshots` -> `providerAutoGenerateTwins`
- Old snapshot-generation keys are not supported for compatibility. Daemon
  startup will fail fast until the config is renamed.
- Web navigation changed:
  - use `Sessions` for routine live session inventory
  - use `Maintenance` for twin cleanup and troubleshooting
- Cleanup naming changed:
  - CLI `--sessions` cleanup language is replaced by `--twins`
  - default twin cleanup preserves metadata and rewrites it to canonical
    no-twin state
  - use `--delete-metadata` when privacy cleanup should also remove matching
    metadata files
- Snippets are no longer persisted in session metadata. Expect older rows to
  show `show snippet` until an operator explicitly reveals the label.

## Release Packaging

- Source-only release (`v0.2.3`).
- Kato Web remains a local Deno/Fresh app managed through `kato web ...`.
- Prebuilt binaries remain deferred to the distribution hardening track.
