---
id: 451qv7hh06v1gwe3dklz0i5
title: 2026 02 23 Awesome Logging
desc: ""
updated: 1771997844711
created: 1771871047984
---

## Goal

Make logging high-signal, configurable, and production-ready:

- clean separation between `operational` and `security-audit`
- explicit audit coverage for security-relevant access failures
- runtime-configurable log levels
- migrate logging backend to LogLayer without losing current JSONL behavior
- use LogLayer OpenTelemetry plugin and establish OpenTelemetry support across
  the codebase

## Why This Matters

- Audit logs are currently too noisy to be reliably useful for security review.
- Some security-relevant file access failures are currently swallowed as normal
  control flow.
- Log verbosity cannot yet be tuned per environment/operator need.
- We want stronger logging ergonomics and composability (`LogLayer`) while
  preserving local-first deterministic behavior.
- We want first-class traces/metrics/log-correlation so daemon/web/cloud can
  share one observability model over time.

## Scope (This Task)

1. Event taxonomy and channel ownership
2. Audit coverage for access-failure events
3. Log level configuration
4. LogLayer adoption/migration
5. OpenTelemetry plugin + codebase-wide instrumentation baseline
6. Tests and docs updates

## Status Checklist

- [ ] 1. Event taxonomy and channel ownership
- [x] 2. Audit coverage for access-failure events
- [x] 3. Log level configuration
- [x] 4. LogLayer adoption/migration (phase 1 parity adapter seam)
- [ ] 5. OpenTelemetry plugin + codebase-wide instrumentation baseline
- [ ] 6. Tests and docs updates (final pass after LogLayer/OTel)

## Decisions To Lock

### 1) Channel Semantics

- `operational.jsonl`:
  - lifecycle and health (`started`, `stopped`, loop state)
  - routine parser/ingestion/runtime behavior
  - performance/throughput/telemetry style events
- `security-audit.jsonl`:
  - policy allow/deny decisions
  - command-control actions with security relevance
  - denied/failed access attempts and high-risk failures

### 2) Noise Reduction

- move these to TRACE level:
  - provider.ingestion.poll
- move these to DEBUG level:
  - Provider ingestion dropped duplicate events (maybe a new event, provider.ingestion.events_dropped.duplicate)
- Remove or downgrade audit events that are purely telemetry and do not carry
  security value.

### 3) Access-Failure Audit Events

Introduce explicit security-audit events for file access failures in ingestion:

- `provider.ingestion.read_denied` (permission denied while reading session
  roots/files)
- include attributes:
  - `provider`
  - `operation` (`stat`, `readDir`, `open`, etc.)
  - `targetPath`
  - `reason` / error message

Behavior:

- permission-denied should not be silently dropped
- event should be written to `security-audit` and (optionally) `operational`
  with appropriate level

### 4) Log Level Configuration

Add configurable minimum levels per channel.

Candidate runtime config shape:

```json
{
  "logging": {
    "operationalLevel": "info",
    "auditLevel": "info"
  }
}
```

Level set:

- `debug`
- `info`
- `warn`
- `error`

Precedence:

1. explicit CLI override (if added in this task)
2. environment overrides
3. runtime config
4. built-in defaults

Minimum requirement for this task:

- runtime config + env override support
- no recompilation needed to change verbosity

### 5) LogLayer Adoption

Adopt LogLayer as backend while preserving current contracts:

- keep existing record schema compatibility (`timestamp`, `level`, `channel`,
  `event`, `message`, `attributes`)
- keep file sink behavior (JSONL in runtime log directory)
- preserve separation of channels/sinks

Migration approach:

1. add thin adapter so existing call sites keep using the local logger facade
2. route facade through LogLayer internals
3. keep fallback/noop behavior for tests
4. remove old internals after parity is proven

### 6) OpenTelemetry Support (Codebase-Wide)

Use LogLayer OpenTelemetry plugin and wire OpenTelemetry conventions as a
general platform capability, not daemon-only glue.

Requirements:

- LogLayer OpenTelemetry plugin is the canonical bridge for log/trace
  correlation.
- `trace_id` / `span_id` are attached to structured log records when span
  context exists.
- Add lightweight instrumentation helpers usable across apps (`daemon`, `web`,
  `cloud`) to avoid ad-hoc tracing code.
- Default remains local-first/safe:
  - OTel export disabled unless explicitly enabled.
  - No hard runtime dependency on remote collector availability.

Candidate config shape:

```json
{
  "logging": {
    "operationalLevel": "info",
    "auditLevel": "info"
  },
  "observability": {
    "otelEnabled": false,
    "serviceName": "kato-daemon",
    "otlpHttpEndpoint": ""
  }
}
```

## Implementation Plan

1. Define/lock event taxonomy

- enumerate events in `apps/daemon/src`
- classify each as operational vs security-audit vs both
- update `dev.codebase-overview` with the rule set

2. Add access-denied audit instrumentation

- ingestion path existence checks (`Deno.stat`)
- directory traversal (`Deno.readDir`)
- session file reads/parsing entrypoints

3. Add logging config contract

- extend shared runtime config contract and parser validation
- fail-closed on unknown logging keys/levels
- wire resolved levels into logger construction in daemon startup and CLI

4. Integrate LogLayer

- add adapter in `apps/daemon/src/observability/`
- migrate sinks and level filtering
- maintain current JSONL output contract

5. Remove redundant/noisy events from audit channel

- keep only security/control/policy events
- verify high-volume telemetry is operational-only or removed

6. OpenTelemetry integration

- integrate LogLayer OpenTelemetry plugin in the logger adapter
- add span wrappers for key flows:
  - CLI command execution
  - daemon runtime loop ticks/control request handling
  - provider ingestion poll/parse
  - recording pipeline writes/exports
- define shared span/attribute naming conventions for cross-app consistency

7. Tests + docs

- update/extend unit/integration tests
- update guidance docs with new logging behavior and configuration

## Testing Plan

- Unit tests:
  - level filtering by channel
  - config parsing/validation for logging section
  - environment override precedence
  - OTel enable/disable config behavior
- Integration tests:
  - denied read access emits `provider.ingestion.read_denied` audit event
  - noisy telemetry events (including `cursor_updated`) do not appear in audit
  - JSONL output schema remains stable
  - when OTel is enabled, logs include trace/span correlation fields
- Regression tests:
  - daemon runtime still starts/stops with default config
  - existing audit-critical events (`policy.decision`) remain present
  - system behaves correctly when OTel exporter endpoint is unavailable

## Acceptance Criteria

- Audit log contains security-relevant events, not routine ingestion telemetry.
- Permission-denied read/access failures are explicitly auditable.
- Log levels are configurable at runtime (config + env override at minimum).
- LogLayer backs the logging pipeline without breaking JSONL output contract.
- LogLayer OpenTelemetry plugin is wired and can emit correlated telemetry when
  enabled.
- OTel support is reusable across the codebase (not hard-coded to daemon-only
  internals).
- CI passes with updated tests/docs.

## Open Questions

- Should CLI include explicit runtime logging override flags now, or defer to
  config/env only?
- Do we want per-component levels (ingestion/runtime/writer), or only per
  channel for MVP?
- Which OTel exporter defaults should we support first (OTLP HTTP only, or OTLP
  HTTP + gRPC)?
