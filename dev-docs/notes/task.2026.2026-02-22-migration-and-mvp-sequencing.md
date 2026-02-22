---
id: 5z1m4pgm4tlr95vpyw0z8ge
title: 2026 02 22 migration and mvp sequencing
desc: ''
updated: 1771782826058
created: 1771795200000
---

## Goal

Sequence migration and MVP implementation so foundational contracts and dependencies are locked before deeper feature work.

## Scope (Phase 1)

- CLI control surface (`start`, `stop`, `status`, `export`, `clean`)
- Logging and OpenTelemetry instrumentation baseline.
- File watching.
- Configuration loading and OpenFeature baseline.

## Proposed Sequencing

1. Implement CLI command surface using `@std/cli` parser + in-repo command router.
2. Wire CLI to daemon lifecycle control and one-off operations (`status`, `export`, `clean`).
3. Implement structured logging contract (operational + audit split) and event schemas.
4. Establish telemetry contract (logs + traces + event attributes).
5. Implement OpenFeature baseline in MVP (evaluation contract + local provider defaults).
6. Update documentation and, if needed, security-baseline exceptions.

## Highest-Impact Opportunities (from `stenobot` Audit)

1. Split the old monolithic monitor loop into explicit pipeline stages:
   ingest -> normalize -> command and policy -> write jobs -> writer.
2. Move command parsing and write-path policy checks into one fail-closed decision gate.
3. Consolidate daemon lifecycle behavior behind one control service/IPC contract, with CLI as a thin control client.
4. Replace full-file reparsing cycles with streaming append reads plus durable checkpoints.
5. Stop reparsing raw provider files for status/clean display; persist normalized metadata projections in daemon state.
6. Enforce deterministic source timestamps and fail-closed config/state loading.
7. Reduce dependency surface and prefer Deno-native primitives.

## Library Substitutions (MVP-Safe)

1. CLI: use `@std/cli` + in-repo command router (no Cliffy in MVP).
2. Logging: in-repo JSONL logger + dedicated security-audit sink (no third-party logger in MVP).
3. File watching: `Deno.watchFs` + in-repo debounce/settle utility (no `chokidar`).
4. Time/date formatting: use native `Intl` and small local utilities unless advanced requirements appear.
5. IDs/frontmatter IDs: prefer `crypto.randomUUID()` unless compact IDs are explicitly required.
6. Config loading: schema-validated config with fail-closed startup behavior.
7. Streams/parsing: use `@std/streams` (`TextLineStream`) for file processing.

## Rearchitecture Shape (Explicit CLI Role)

1. `apps/daemon`:
   - `src/cli`: CLI entry + router for daemon control (`start`, `stop`, `status`) and one-off ops (`export`, `clean`).
   - `src/orchestrator`: long-running coordinator for provider ingestion, policy decisions, and worker supervision.
   - `src/providers`: provider-specific discovery and parsing adapters.
   - `src/writer`: destination-scoped writer workers and append pipeline.
   - `src/observability`: operational logger and security audit logger.
2. `shared/src`:
   - command grammar and policy contracts.
   - normalized message/event/status contracts used across daemon, web, and cloud apps.
3. `apps/web`:
   - read-only status surfaces from daemon snapshots only.
4. `apps/cloud`:
   - aggregation, centralized policy/config integration, and fleet-level status rollups.

## Decisions To Keep Aligned

1. Service-manager integration remains post-MVP (no `systemd`, launchd, or Windows Service in MVP).
2. OpenFeature is included from MVP start.

## Out of Scope (MVP)

1. Native service-manager integration (`systemd`, launchd, Windows Service).
2. Sentry. Should be build-time optional and runtime-optional behind config with no-network default?
