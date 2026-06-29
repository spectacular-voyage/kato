---
id: ve1xd8l46p0r7zkh6gvrjir
title: Product Ideas
desc: ''
updated: 1781196454564
created: 1773431441018
---

## Purpose

This is Kato's consolidated product idea bank. It includes promising future directions that are not yet committed implementation work.

Use [[roadmap]] for prioritized work and [[features]] for shipped behavior.

## Output And Capture Ideas

- Separate markdown and JSONL filename templates.
- Add richer JSONL output metadata once JSONL recording is promoted beyond export-only use.
- Allow multiple active recordings to intentionally write to one consolidated output file.
- Add output heading templates:
  - product/provider display name, not just model name;
  - configured nickname/persona;
  - sequential or event-id headings instead of `User_unknown-time` fallbacks.
- Add an opt-in AI-assisted title/summary mode:
  - summarize first speech act in a bounded word count;
  - optionally replace provisional titles after more conversation context is available;
  - require explicit network/model permission.
- Add a command or web action that creates or updates a summary file, decision log, or to-do note from a captured conversation. This should stay explicit because it likely involves AI/network access.
- Add per-session or per-output writer overrides for commentary, thinking, tool calls/results, and related writer flags.
- Add in-chat flags to `::capture`, `::record`, and `::export` once command parsing can distinguish output paths from control options cleanly.

## Metadata, Tags, And Personas

- Add persisted session/output metadata for titles, tags, personas, and other output-scoped settings. See [[task.2026.2026-06-11-session-output-metadata]].
- Add creation-time title and filename slug overrides for web captures and recordings. See [[task.2026.2026-06-28-output-filename-title-overrides]].
- Add output tagging with shared workspace tag libraries and personal user-level tag suggestions. See [[task.2026.2026-06-11-output-tagging]].
- Add persona support for configured prefixes, participant labels, and persona/model-aware headings. See [[task.2026.2026-05-28-persona-support]].
- Let web-created captures and recordings accept metadata before creation.
- Let users edit metadata after recording starts and update markdown frontmatter without appending conversation content.

## Workspace And Web Ideas

- Add workspace config editing in Kato Web. See [[task.2026.2026-06-11-workspace-config-editing]].
- Add a full markdown/twin review surface:
  - review an entire persisted twin;
  - review a generated recording/export file;
  - expose useful source/session context without forcing file-manager use.
- Expand Kato Web status pages:
  - surfaced in-chat commands;
  - command history;
  - runtime performance and scan timing;
  - clearer provider/session ingest state.
- Scan recently active provider folders more often and older folders less often.
- Discover `.codex`, `.claude`, and similar provider folders even when they were not present at daemon startup.
- Store workspace alias mapping and display preferences cleanly in shared config/registry.

## Privacy And Safety Ideas

- Add user-configured redaction lists:
  - literal words;
  - sentences;
  - paths;
  - regexes;
  - entire chats or providers by matching rule.
- Add a `::seal` or equivalent action that closes an output with a signature or hash. The design needs care because writing a file hash into the same file changes the file being hashed.
- Define explicit alias-error handling for recording/export:
  - default user-facing CLI/web/daemon status error messaging;
  - optional silent-failure behavior only when a user explicitly enables it;
  - logs should still capture unexpected aliases.

## Provider And Interoperability Ideas

- Add provider support for Kimi, Copilot, Roo, Cline, OpenCode, and other local AI tools with inspectable session artifacts.
- Explore `strongdm/cxdb` export compatibility: <https://github.com/strongdm/cxdb>.
- Consider whether Kato should expose a stable library/API surface before reopening JSR or other library-oriented distribution channels.

## Distribution And Lifecycle Ideas

- Add Homebrew packaging.
- Add channel-aware self-update only when Kato can reliably detect which install channel owns the current binaries.
- Preserve these distribution constraints:
  - installs should be user-scoped first;
  - program files should stay outside `~/.kato`;
  - runtime/config/state should stay inside `~/.kato`;
  - uninstall should preserve `~/.kato` by default unless the user explicitly purges data;
  - update/uninstall behavior must be channel-aware so npm, installers, direct archives, and source checkouts do not fight each other.
- Add stable shell and PowerShell installer entrypoints that detect OS/arch, download release assets, verify checksums, install into a user-local program directory, and write install metadata.
- Consider Windows portable `.zip`, per-user signed installer, and WinGet after direct binary installs are stable.
- Add explicit per-user background integration:
  - `systemd --user`;
  - macOS LaunchAgents;
  - Windows per-user startup mechanism;
  - install/uninstall helpers as explicit commands, not package side effects.
