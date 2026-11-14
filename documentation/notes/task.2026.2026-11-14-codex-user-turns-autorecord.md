---
id: hz2026111401codexuserturns
title: Codex user turns and auto-record for app-server sessions
desc: Read user turns from response_item messages with role user, carry the Codex session cwd, and let Codex sessions auto-record like Claude ones.
updated: 1794680000000
created: 1794680000000
---

## Goal

Codex sessions driven through the app-server (no TUI) must record their user turns, respond to in-chat `::` commands, and auto-record into a workspace whose roots contain their working directory, exactly as Claude sessions do.

## Summary

Found on galactica on 2026-11-14 (kato issue #61). Phoenix's Codex seats write user input to the rollout only as `{"type":"response_item","payload":{"type":"message","role":"user",...}}`; there is no `event_msg` / `user_message` record (0 of 11 rollouts touched that day). The Codex parser emitted `message.user` only from `event_msg` / `user_message`, so every Codex twin and recording was assistant-only and a typed `::capture-notes` was never seen. Separately, auto-record was gated to Claude because only the Claude parser attached a working directory, although Codex rollouts carry `cwd` in `session_meta` and every `turn_context`.

## Decisions

- `response_item` / `message` with `role: "user"` becomes a `message.user` event (`providerEventType: response_item.message.user`). User parts are `input_text` (and `text`), read by a user-specific extractor; the assistant extractor still reads `text` only.
- Codex-injected context written with role user is not a user turn. Only the known markers are skipped: a text starting with `<environment_context`, `<codex_internal_context`, `<user_instructions`, `<turn_aborted` or `<external_codex_apps` (with any suffix, such as `_open_page`), or with `# AGENTS.md instructions for `. A user's own tag (`<div>`, an app's `<send_user_message_question_reply>`) stays a user turn (CodeRabbit, PR 62).
- A rollout can carry the same user turn twice (TUI sessions emit the `response_item` and then `event_msg` / `user_message`, both after the turn's `task_started`); identical text within the same `task_started` turn is emitted once. The de-duplication is keyed to that turn and also clears when the assistant speaks, so identical prompts in later turns (the shop's repeated mail nudges, or a prompt resent after an interrupted turn) are kept. State transitions run on replayed lines too, so a resumed parse emits what a full parse emits (CodeRabbit, PR 62).
- `session_meta.cwd` and `turn_context.cwd` set the session working directory, attached to every event's `source.workingDirectory`, and persisted in the parser checkpoint state with the de-duplication text.
- `inferSessionWorkingDirectory` and `applyWorkspaceAutoRecording` accept `codex` beside `claude`. Gemini is unchanged: its parser attaches no working directory.

## Verification

- `tests/codex-parser_test.ts`: new fixture `codex-session-appserver-user.jsonl` (shaped from real Phoenix rollouts): three user turns emitted once each, injected context skipped, working directory on every event, checkpoint resume identical.
- `tests/daemon-runtime_test.ts`: the former "does not auto-record non-Claude sessions" case now asserts a Codex session with a matching working directory gets a workspace output and an append.
- Real rollouts: see the PR for the count of `message.user` events parsed from a live Phoenix Codex rollout before and after.

## Outcome

In review on `hazel/codex-user-turns-autorecord`. Deployment is a release and reinstall (the daemon runs from the npm package), not a config change.
