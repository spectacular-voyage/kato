---
id: v2j7vx3n6krg0c5w6tr3m3k
title: Roadmap
desc: ''
updated: 1781196283737
created: 1773868244789
---

## Purpose

This note is the consolidated roadmap and engineering backlog for Kato.

Use [[features]] for shipped behavior and [[product-ideas]] for ideas that are not yet committed. Detailed execution plans belong in dated `task.*` notes.

## Current Focus

The next product arc is making Kato's saved outputs easier to configure, describe, and review after capture starts.

- [ ] Land the shared session/output metadata foundation in [[task.2026.2026-06-11-session-output-metadata]].
- [ ] Add web-based shared workspace config editing in [[task.2026.2026-06-11-workspace-config-editing]].
- [ ] Add output tagging in [[task.2026.2026-06-11-output-tagging]].
- [ ] Add persona support in [[task.2026.2026-05-28-persona-support]].
- [ ] Update CLI flows to match newer web summary, session, and ingestion distinctions.

## Product Roadmap

### Output Control And Review

- [ ] Let users edit recording/output title, tags, persona, and selected writer settings after an output has started.
- [ ] Add a full markdown/twin review surface for captured conversations and generated files.
- [ ] Add metadata-only frontmatter updates for supported markdown outputs.
- [ ] Support JSONL recording once the active writer pipeline has a configured JSONL writer.

### Workspace Management

- [ ] Add a web editor for `.kato-workspace-config.yaml` fields that users already rely on: output directory, filename template, timezone, frontmatter toggles, relative-link mode, and Dendron wikilinks.
- [ ] Add workspace pre-persist verification and runtime re-verification status (`valid`, `invalid`, `unverified`) with explicit reasons.
- [ ] Decide whether "workspace" should eventually become "destination" in user-facing language. Publish a decision note before broad rename work.

### Setup And Configuration

- [ ] Add `kato config validate` for preflight runtime and shared config checks.
- [ ] Improve startup error UX for config/schema failures with actionable remediation hints.
- [ ] Add an interactive `kato init` prompt for common user defaults such as participant username.
- [ ] Support relative paths for in-chat command arguments and config `allowedWriteRoots` only after the path-policy contract is explicit.

## Runtime And Ingestion Backlog

- [ ] Add schema fail-closed checks when persisted snapshot files are added, with a `kato clean --all` remediation hint for v1 data.
- [ ] Extend `SessionSnapshotStore` with `delete`/`clear` and wire it into `clean` behavior.
- [ ] Add permission-boundary tests proving provider reads are denied outside `providerSessionRoots`.
- [ ] Harden provider-aware lookup paths where CLI/runtime reads can still be ambiguous by provider session id alone.
- [ ] Decide whether to redesign mid-turn cursor advancement so polling cannot split one logical assistant turn into separate snapshot entries.
- [ ] Add an explicit SessionTwin compaction/retention policy.
- [ ] Optimize `resolveConversationTitle` dedup/memoization in daemon runtime if profiling shows it matters.

## Config And Compatibility Backlog

- [ ] Define runtime config versioning/migration strategy for `featureFlags`, `providerSessionRoots`, and future schema changes.
- [ ] Document compatibility policy for newer config fields versus older daemon builds.
- [ ] Add migration tests for older/newer config compatibility scenarios.
- [ ] Re-evaluate centralized/OpenFeature provider integration once cloud control-plane work begins.
- [ ] Remove compatibility-layer cruft once supported migrations make it safe.

## Observability And Security Backlog

- [ ] Define event schema/version contract for operational and audit logs.
- [ ] Add sensitive-field redaction tests for log sinks.
- [ ] Add audit-completeness tests for critical allow/deny decisions.
- [ ] Add `ConversationEventKind` support for Codex plan documents or other provider-native document types once their semantics are clear.

## Distribution Backlog

- [ ] Finalize least-privilege compile permissions for `kato`, `kato-daemon`, and `kato-web`, with launcher-only spawning power where possible.
- [ ] Expand packaged-bundle smoke checks to full daemon lifecycle and full web lifecycle coverage.
- [ ] Add downloadable-archive smoke checks that extract real `.tar.gz` and `.zip` artifacts and rerun core binary/web assertions.
- [ ] Add automated tests for `scripts/package-binaries.ts` covering bundle contents, emitted metadata, archives, and checksums.
- [ ] Add permission regression checks proving compiled binaries honor app-level path policy outside configured roots.
- [ ] Add signing/notarization before direct binary installs become the default documented path.
- [ ] Add Homebrew packaging.
- [ ] Design channel-aware upgrade/uninstall metadata before adding any `kato upgrade` command.
- [ ] Add explicit per-user background integration for `systemd --user`, launchd LaunchAgents, and Windows startup mechanisms.

## Deferred Evaluations

- [ ] Re-evaluate additional CLI framework features only if command UX outgrows the current router.
- [ ] Re-evaluate `zod` only if boundary validation complexity materially increases.

## Known Risks

- Duplicate `workspaceId` values across two different workspace roots on one machine are very unlikely, but registration treats that as a conflict.
- Mid-turn ingestion redesign is potentially large; do not pull it into a small release unless the user-facing split-output behavior is reproducible and worth the churn.
