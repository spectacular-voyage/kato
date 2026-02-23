---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ''
updated: 1771812869620
created: 1771812869620
---

## Current Next Tasks

## Runtime And Ingestion Follow-ups

- [ ] Persist provider cursors across daemon restarts (disk-backed cursor state).
- [ ] Extend `SessionSnapshotStore` with `delete`/`clear` and wire it into
      `clean` command behavior.
- [ ] Retire `loadSessionMessages` legacy export fallback once all paths use
      `loadSessionSnapshot`.
- [ ] Add permission-boundary tests that prove provider reads are denied outside
      `providerSessionRoots`.

## CLI And Runtime Hardening

- [ ] Add explicit startup handshake/ack mechanism so `start` no longer writes optimistic running state before daemon confirmation.
- [ ] Add `kato config validate` command for preflight runtime config checks.
- [ ] Improve startup error UX for config/schema failures with actionable remediation hints.

## Config And Feature-Flag Evolution

- [ ] Define explicit versioning/migration strategy for runtime config
      (`featureFlags`, `providerSessionRoots`).
- [ ] Decide and document compatibility policy for newer config fields vs older
      daemon builds.
- [ ] Re-evaluate remote/centralized OpenFeature provider integration once cloud control-plane work begins.

## Observability And Security Follow-Through

- [ ] Define event schema/version contract for operational and audit logs.
- [ ] Add sensitive-field redaction tests for log sinks.
- [ ] Add audit-completeness tests for critical allow/deny decisions.

## Testing And Packaging

- [ ] Add production packaging guidance/scripts for `deno compile` with least-privilege permissions.
- [ ] Add permission-profile smoke coverage for compiled/binary-style runtime.
- [ ] Add migration tests for config evolution scenarios (older/newer config compatibility).

## Deferred Post-MVP Tracks

- [ ] Service-manager integration evaluation (`systemd`, launchd, Windows Service).
- [ ] Re-evaluate additional CLI framework features (Cliffy) only if command UX outgrows current router.
- [ ] Re-evaluate `zod` adoption only if boundary validation complexity materially increases.
