---
id: 6rlpvq0gr5n5n62yc8zrgg73
title: 'Release Notes v0.2.21'
desc: Codex conversations record user turns and auto-record inside a workspace root, as Claude conversations already do.
updated: 1794686094820
created: 1794686094820
---

## Summary

`v0.2.21` makes Codex conversations record properly (#61, PR #62).

Codex sessions driven through the app server write user input only as `response_item` messages with role `user`. Kato read user text only from `event_msg` / `user_message`, so those sessions recorded no user turns at all, and in-chat commands such as `::capture-notes` were never seen. Codex sessions were also never auto-recorded, because only Claude sessions carried a working directory.

On a live Codex rollout the parser now yields 34 user turns where it yielded 0, and every event carries the session's working directory.

## User-facing Changes

- **Codex user turns are recorded.** A `response_item` message with role `user` becomes a user message (`input_text` or `text` parts).
- **Injected context isn't a turn.** Codex's `<environment_context>`, `<codex_internal_context>`, `<user_instructions>`, `<turn_aborted>` and AGENTS.md injections are skipped.
- **Each turn once.** TUI sessions write a user turn twice (`event_msg` and `response_item`); identical text within a turn is recorded once. The de-duplication resets when the assistant replies, so a repeated prompt in a later turn is kept.
- **Working directory.** `session_meta.cwd` and `turn_context.cwd` set the session's working directory. It's attached to every event and kept in the parser checkpoint, so a resumed session keeps it.
- **Codex auto-record.** Codex sessions whose working directory is inside an `autoRecordRoots` entry now auto-record, as Claude sessions do. Gemini is unchanged.

## Upgrading

No configuration change. Install the new package and restart the daemon. Existing Claude recordings re-attach after the restart, and Codex sessions under an auto-record root start recording on their own.
