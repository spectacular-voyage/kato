---
id: v2j7vx3n6krg0c5w6tr3m3k
title: Roadmap
desc: ''
updated: 1781196283737
created: 1773868244789
---

## Purpose

This note is the consolidated product roadmap for Kato.

Use [[features]] for shipped behavior, [[product-ideas]] for ideas that are not yet committed, and [[dev.todo]] for technical or administrative nits. Detailed execution plans belong in dated `task.*` notes.

## Current Focus

The next product arc is making Kato's saved outputs easier to configure, describe, and review after capture starts.

- [ ] Land the shared session/output metadata foundation in [[task.2026.2026-06-11-session-output-metadata]].
- [ ] Validate the first editable-recording path with per-output writer controls in [[task.2026.2026-05-11-per-output-writer-controls]].
- [ ] Add web-based shared workspace config editing in [[task.2026.2026-06-11-workspace-config-editing]].
- [ ] Add output tagging in [[task.2026.2026-06-11-output-tagging]].
- [ ] Add persona support in [[task.2026.2026-05-28-persona-support]].

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
- [ ] Update CLI flows to match newer web summary, session, recording-output, and ingestion distinctions after the web path settles.
- [ ] Support relative paths for in-chat command arguments and config `allowedWriteRoots` only after the path-policy contract is explicit.

## Runtime And Ingestion Backlog

- [ ] Add an explicit SessionTwin compaction/retention policy.
- [ ] Add `ConversationEventKind` support for Codex plan documents or other provider-native document types once their semantics are clear.

## Distribution Backlog

- [ ] Finalize least-privilege compile permissions for `kato`, `kato-daemon`, and `kato-web`, with launcher-only spawning power where possible.
- [ ] Add signing/notarization before direct binary installs become the default documented path.
- [ ] Add Homebrew packaging.
- [ ] Design channel-aware upgrade/uninstall metadata before adding any `kato upgrade` command.
- [ ] Add explicit per-user background integration for `systemd --user`, launchd LaunchAgents, and Windows startup mechanisms.

## Known Risks

- Duplicate `workspaceId` values across two different workspace roots on one machine are very unlikely, but registration treats that as a conflict.
- Mid-turn ingestion redesign is potentially large; do not pull it into a small release unless the user-facing split-output behavior is reproducible and worth the churn.
