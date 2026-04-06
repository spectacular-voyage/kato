---
id: ksyvoukd3hadhqwn36jvpe4
title: Release Notes v0.2.0
desc: ''
updated: 1772637370160
created: 1772637171821
---

# kato v0.2.0 (2026-03-04)

First release, delivered as a source-only cut.

## Highlights

- CLI/daemon split is now in place, with cleaner lifecycle commands (`start`, `stop`, `restart`, `status`) and more reliable runtime boundaries.
- In-chat controls require workspace specification (via alias): `::capture-<alias>`, `::record-<alias>`, `::stop`, and `::export-<alias>`.
- Workspace-driven recording flow is established with alias registration and customizable workspace config at `<workspace>/.kato-workspace-config.yaml`.
- Export pipeline supports both markdown (with richer frontmatter) and JSONL for event-level workflows.
- Status and runtime observability are stronger, including surfaced recent errors and better stale-state/control healing behavior.
- Provider/session ingestion and recording durability were hardened across this release line, including snapshot/twin handling and broad test coverage improvements.

## Notable Behavior Updates

- Runtime defaults to `~/.kato/daemon` (global-first); use `KATO_RUNTIME_DIR` to opt into a specific runtime location.
- No implicit `./.kato` fallback for runtime state.

## Release Packaging

- Source-only release (`v0.2.0`).
- Prebuilt binaries are intentionally deferred to a follow-up hardening track.
