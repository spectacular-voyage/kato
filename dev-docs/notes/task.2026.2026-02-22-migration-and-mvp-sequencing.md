---
id: 5z1m4pgm4tlr95vpyw0z8ge
title: 2026 02 22 migration and mvp sequencing
desc: ''
updated: 1771787830205
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

## Execution Checklist

- [x] CLI parser/router scaffold with strict grammar (`start`, `stop`, `status`, `export`, `clean`).
- [x] Logging baseline scaffold (`StructuredLogger` + `AuditLogger`, split channels).
- [x] File watching baseline (`Deno.watchFs` debounce/settle utility).
- [x] Step 1: status/control control-plane files + CLI wiring to control-plane stores.
- [x] Step 2: command detection and fail-closed path-policy decision gate.
- [ ] Step 3: writer pipeline + destination rotation ordering + dedupe append guard.
- [ ] Step 4: config/OpenFeature boundary validation hardening and startup fail-closed behavior.
- [ ] Step 5: Fill out [[dev.codebase-overview]] and update key documentation:
  - [[dev.general-guidance]]
  - [[dev.codebase-overview]]
  - [[dev.decision-log]]

## Highest-Impact Opportunities (from `stenobot` Audit)

1. Split the old monolithic monitor loop into explicit pipeline stages:
   ingest -> normalize -> command and policy -> write jobs -> writer.
2. Move command parsing and write-path policy checks into one fail-closed decision gate.
3. Consolidate daemon lifecycle behavior behind one control service/IPC contract, with CLI as a thin control client.
4. Replace full-file reparsing cycles with streaming append reads plus durable checkpoints.
5. Stop reparsing raw provider files for status/clean display; persist normalized metadata projections in daemon state.
6. Enforce deterministic source timestamps and fail-closed config/state loading.
7. Reduce dependency surface and prefer Deno-native primitives.

## Integrate Now (from Claude Analysis)

1. Preserve parser invariants as explicit migration acceptance criteria:
   - Claude turn aggregation + pending tool result linking.
   - Codex `final_answer` preference, fallback handling, and offset resume behavior.
2. Carry forward exporter append dedupe guard (prevent duplicate tail writes during repeated polls).
3. Harden command detection to ignore fenced code blocks, not only inline backtick spans.
4. Treat provider checkpoints as provider-defined cursors, not byte offsets only (supports non-JSONL providers).
5. Add explicit writer rotation ordering: evaluate path policy first, then rotate/start destination writer.
6. Keep `decodeProjectDir` out of Kato migration scope (legacy heuristic intentionally left behind).

## Library Substitutions (MVP-Safe)

1. CLI: use `@std/cli` + in-repo command router (no Cliffy in MVP).
2. Logging: in-repo JSONL logger + dedicated security-audit sink (no third-party logger in MVP).
3. File watching: `Deno.watchFs` + in-repo debounce/settle utility (no `chokidar`).
4. Time/date formatting: use native `Intl` and small local utilities unless advanced requirements appear.
5. IDs/frontmatter IDs: prefer `crypto.randomUUID()` unless compact IDs are explicitly required.
6. Config loading: schema-validated config with fail-closed startup behavior.
7. Streams/parsing: use `@std/streams` (`TextLineStream`) for file processing.

## Validation Strategy (Framed Decision)

Decision question:
- Should runtime validation in MVP use `zod` broadly or be limited to boundary surfaces with inline guards internally?

Options:
1. `zod` everywhere.
2. Inline guards everywhere.
3. Hybrid: `zod` at external trust boundaries, inline guards in internal/hot paths.

Recommended for MVP:
1. Hybrid approach.
2. Use `zod` for config/env loading and other external payload boundaries.
3. Use inline guards/type predicates in parser loops and small internal envelopes.
4. Keep validation fail-closed at all boundary entry points.

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

## IPC Distinction (MVP)

1. Distinguish worker IPC (provider/writer/orchestrator) from CLI control-plane IPC.
2. For MVP, prefer atomic status/control files for CLI read paths and simple control signaling.
3. Defer Unix domain socket control-plane transport to post-MVP portability hardening.
4. If Windows control-plane transport is needed later, evaluate named pipes as the Windows-first option.

## Decisions To Keep Aligned

1. Service-manager integration remains post-MVP (no `systemd`, launchd, or Windows Service in MVP).
2. OpenFeature is included from MVP start.

## Out of Scope (MVP)

1. Native service-manager integration (`systemd`, launchd, Windows Service).
2. Sentry. Should be build-time optional and runtime-optional behind config with no-network default?
