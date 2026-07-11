---
id: v2j7vx3n6krg0c5w6tr3m3k
title: Roadmap
desc: ''
updated: 1781196283737
created: 1773868244789
---

## Purpose

This note is the high-level product roadmap for Kato.

Use [[features]] for shipped behavior, [[product-ideas]] for ideas that are not yet committed, and [[dev.todo]] for the working board. Detailed execution plans belong in dated `task.*` notes.

## Where We Are

Kato is closing the first saved-output metadata and configuration arc. The foundation now covers session/output metadata, per-output writer controls, creation-time title and filename snippet overrides, shared workspace config editing, and first-class web output tagging. The current delivery state for that release lives in [[dev.todo]].

## Near-Term Direction

The next product arc should make saved outputs easier to describe, personalize, and review after capture starts.

### Output Control And Review

- Complete persona support so configured assistant/persona labels can shape output metadata, headings, and filename templates without confusing model provenance with human-facing participants.
- Expand post-start output editing beyond tags and writer flags to cover title/persona metadata consistently across active and stopped outputs.
- Add a full markdown/twin review surface for captured conversations and generated files.
- Keep markdown frontmatter as descriptive metadata synchronized from persisted state, not as the source of truth.
- Support JSONL recording once the active writer pipeline has a configured JSONL writer.

### Workspace Management

- Harden the workspace config editor with clearer verification status and recovery paths for invalid or stale workspace configs.
- Add workspace pre-persist verification and runtime re-verification status (`valid`, `invalid`, `unverified`) with explicit reasons.
- Decide whether "workspace" should eventually become "destination" in user-facing language. Publish a decision note before broad rename work.

### Setup And Configuration

- Add `kato config validate` for preflight runtime and shared config checks.
- Improve startup error UX for config/schema failures with actionable remediation hints.
- Add an interactive `kato init` prompt for common user defaults such as participant username.
- Update CLI flows to match newer web summary, session, recording-output, and ingestion distinctions after the web path settles.
- Support relative paths for in-chat command arguments and config `allowedWriteRoots` only after the path-policy contract is explicit.

## Later Bets

- Add an explicit SessionTwin compaction/retention policy.
- Add `ConversationEventKind` support for Codex plan documents or other provider-native document types once their semantics are clear.
- Finalize least-privilege compile permissions for `kato`, `kato-daemon`, and `kato-web`, with launcher-only spawning power where possible.
- Add signing/notarization and Homebrew packaging before direct binary installs become the default documented path.
- Design channel-aware upgrade/uninstall metadata before adding any `kato upgrade` command.
- Add explicit per-user background integration for `systemd --user`, launchd LaunchAgents, and Windows startup mechanisms.

## Known Risks

- Duplicate `workspaceId` values across two different workspace roots on one machine are very unlikely, but registration treats that as a conflict.
- Mid-turn ingestion redesign is potentially large; do not pull it into a small release unless the user-facing split-output behavior is reproducible and worth the churn.
