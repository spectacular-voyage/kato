---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ''
updated: 1772257357673
created: 1771812869620
---

## Event Schema Follow-ups (v2)

- [ ] Add `request_user_input` Codex fixture under `tests/fixtures/` and add
      explicit questionnaire→decision event synthesis tests.
- [ ] Add explicit cross-kind collision test: assert two events with same
      content/timestamp but different `kind` do NOT dedupe.
- [ ] Add schema fail-closed check when persisted snapshot files are added
      (fail with `kato clean --all` remediation hint on v1 data).
- [ ] Add `JsonlConversationWriter` to active recording pipeline (currently
      only markdown recordings are appended; JSONL write mode is export-only).

## Runtime And Ingestion Follow-ups

- [ ] Extend `SessionSnapshotStore` with `delete`/`clear` and wire it into
      `clean` command behavior.
- [ ] Add permission-boundary tests that prove provider reads are denied outside
      `providerSessionRoots`.
- [ ] Snapshot projection still keys in-memory reads by provider session id; harden
      provider-aware lookup paths where CLI/runtime can still be ambiguous.
- [ ] _maybe_ Fix mid-turn cursor advancement: cursor must not advance past an incomplete
      multi-entry assistant turn; polling at a turn boundary splits one logical
      event into two separate snapshot entries that dedupe cannot collapse. This
      requires the ingestion runner to detect turn boundaries per provider (e.g.
      `task_complete`/`final_answer` for Codex; consecutive assistant entries for
      Claude) and buffer partial turns between polls — significant redesign.
- [ ] Add explicit SessionTwin compaction/retention policy (v1 is append-only).

## CLI And Runtime Hardening

- [ ] Add `kato config validate` command for preflight runtime config checks.
- [ ] Improve startup error UX for config/schema failures with actionable remediation hints.
- [ ] Add workspace command surface: `kato workspace register|list|unregister|discover`.
- [ ] Add workspace pre-persist verification and runtime re-verification status
      (`valid|invalid|unverified`) with explicit error reasons.
- [ ] Add workspace-aware relative path resolution (session workspace identity)
      so in-chat relative targets do not depend on daemon cwd.

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

## Other

- [ ] defaultParticipantUsername still uses string with "" default in config.ts.
- [ ] resolveConversationTitle call dedup/memoization in daemon runtime is still an optimization opportunity.
- [ ] remove all compatibility-layer cruft
- [ ] Supporting relative paths for in-chat command arguments and config allowedWriteRoots