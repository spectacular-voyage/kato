---
id: mhthe39ktidk76iy77kcxbn
title: Todo
desc: ""
updated: 1781196292514
created: 1771812869620
---

## Runtime And Ingestion Nits

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
