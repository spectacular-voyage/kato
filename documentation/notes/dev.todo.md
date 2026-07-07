---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ""
updated: 1781196292514
created: 1771812869620
---

This note is the working board for developer-facing project state. Keep product direction in [[roadmap]], shipped behavior in [[features]], and detailed implementation plans in dated `task.*` notes.

## In Flight

- [x] Land the shared session/output metadata foundation in [[task.2026.2026-06-11-session-output-metadata]].
- [x] Validate the first editable-recording path with per-output writer controls in [[task.2026.2026-05-11-per-output-writer-controls]].
- [x] Add creation-time output title and filename slug overrides through the web capture/recording flow in [[ka.completed.2026.2026-06-28-output-filename-title-overrides]].
- [x] Add web-based shared workspace config editing in [[task.2026.2026-06-11-workspace-config-editing]].
- [x] Add the web-first output tagging slice in [[task.2026.2026-06-11-output-tagging]].
- [x] Fix the Sessions `New capture`/`New recording` popover so the submit actions remain reachable when the trigger is low in the viewport.
- [x] Verify the current v0.2.14 dirty tree with focused formatting/type checks.
- [x] Final review [[release-notes.v0.2.14]] against the dirty tree before release.

## Next Up

- [ ] Update dependent task notes after the tagging implementation choices settle, especially [[task.2026.2026-06-11-session-output-metadata]].
- [ ] Decide whether CLI management for personal tag libraries belongs in the v0.2.14 release or should stay deferred in [[task.2026.2026-06-11-output-tagging]].
- [ ] Start persona support from [[task.2026.2026-05-28-persona-support]] after the output metadata/tagging release is closed.
- [ ] Add workspace pre-persist verification and runtime re-verification status (`valid`, `invalid`, `unverified`) with explicit reasons.
- [ ] Add `kato config validate` for preflight runtime and shared config checks.

## Runtime And Ingestion Backlog

- [ ] Add schema fail-closed checks when persisted snapshot files are added, with a `kato clean --all` remediation hint for v1 data.
- [ ] Extend `SessionSnapshotStore` with `delete`/`clear` and wire it into `clean` behavior.
- [ ] Harden provider-aware lookup paths where CLI/runtime reads can still be ambiguous by provider session id alone.
- [ ] Decide whether to redesign mid-turn cursor advancement so polling cannot split one logical assistant turn into separate snapshot entries.
- [ ] Optimize `resolveConversationTitle` dedup/memoization in daemon runtime if profiling shows it matters.

## Config And Compatibility Nits

- [ ] Define runtime config versioning/migration strategy for `featureFlags`, `providerSessionRoots`, and future schema changes.
- [ ] Document compatibility policy for newer config fields versus older daemon builds.
- [ ] Add migration tests for older/newer config compatibility scenarios.
- [ ] Re-evaluate centralized/OpenFeature provider integration once cloud control-plane work begins.
- [ ] Remove compatibility-layer cruft once supported migrations make it safe.

## Observability And Security Nits

- [ ] Define event schema/version contract for operational and audit logs.
- [ ] Add sensitive-field redaction tests for log sinks.
- [ ] Add audit-completeness tests for critical allow/deny decisions.
- [ ] Add permission-boundary tests proving provider reads are denied outside `providerSessionRoots`.
- [ ] Add permission regression checks proving compiled binaries honor app-level path policy outside configured roots.

## Distribution And Release Nits

- [ ] Expand packaged-bundle smoke checks to full daemon lifecycle and full web lifecycle coverage.
- [ ] Add downloadable-archive smoke checks that extract real `.tar.gz` and `.zip` artifacts and rerun core binary/web assertions.
- [ ] Add automated tests for `scripts/package-binaries.ts` covering bundle contents, emitted metadata, archives, and checksums.

## Deferred Evaluations

- [ ] Re-evaluate additional CLI framework features only if command UX outgrows the current router.
- [ ] Re-evaluate `zod` only if boundary validation complexity materially increases.
