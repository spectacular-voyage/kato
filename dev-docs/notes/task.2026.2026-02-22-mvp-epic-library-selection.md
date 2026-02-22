---
id: 5z1m4pgm4tlr95vpyw0z8ge
title: 2026 02 22 MVP Epic Library Selection
desc: ''
updated: 1771729866379
created: 1771795200000
---

## Goal

Sequence the MVP epic with library choices first, then implementation slices.

## Scope (Phase 1)

- CLI framework decision. Cliffy?
- OpenTelemetry instrumentation baseline.
- Optional Sentry integration point.
- OpenFeature adoption decision and rollout strategy.

## Decision Log Template

- Decision:
- Owner:
- Date:
- Why:
- Tradeoffs:
- Follow-up tasks:

## Proposed Sequencing

1. Pick CLI framework and command surface (`start`, `stop`, `status`, `clean`, `export`).
2. Establish telemetry contract (logs + traces + event attributes).
3. Decide whether Sentry is in MVP or post-MVP.
4. Decide whether OpenFeature is in MVP or feature-gated post-MVP.
5. Freeze the MVP dependency set and update security-baseline exceptions if needed.

## Open Questions

- Is Linux-only service mode acceptable for MVP, with macOS/Windows deferred?
- Do we require OpenFeature in MVP, or is a static config gate enough initially?
- Should Sentry be runtime-optional behind config with no-network default?
