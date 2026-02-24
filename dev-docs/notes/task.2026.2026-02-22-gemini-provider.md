---
id: dpyry3rtit2myhxzfr68zbn
title: 2026 02 22 Gemini Provider
desc: ""
updated: 1771786673216
created: 1771786673216
---

# Gemini Provider Task

## Goal

Add first-class Gemini conversation ingestion to daemon runtime so Gemini
sessions are discoverable, parsed into normalized `ConversationEvent`s, and
available to capture/export workflows.

## Resolved Decisions

1. Implement a dedicated Gemini runner path (no shared-runner refactor).
2. Normalize at turn level for assistant messages.
3. Add `providerSessionRoots.gemini` to runtime config.
4. Prefer `displayContent` over `content` when both are present.
5. Skip Gemini `info` entries for now.
6. Leave workspace-root integration out of scope.

## Implementation Checklist

- [x] Extend runtime contracts/config defaults:
  - [x] `ProviderSessionRoots` includes `gemini`.
  - [x] Add env/config wiring via `KATO_GEMINI_SESSION_ROOTS`.
  - [x] Keep fail-closed config validation behavior.
- [x] Add Gemini parser:
  - [x] Parse JSON session files (`messages[]`) instead of JSONL lines.
  - [x] Emit `message.user`, `message.assistant`, `thinking`, `tool.call`, and
        `tool.result`.
  - [x] Prefer `displayContent`; skip `info` events.
  - [x] Use `item-index` cursors for resume semantics.
- [x] Add Gemini ingestion runner:
  - [x] Discover `session-*.json` files under configured roots.
  - [x] Parse and merge events into session snapshots.
  - [x] Register in default ingestion runner factory.
- [x] Wire daemon launcher/runtime:
  - [x] Add Gemini roots to subprocess read scope.
  - [x] Pass `KATO_GEMINI_SESSION_ROOTS` to detached daemon process.
  - [x] Pass `providerSessionRoots.gemini` through CLI/runtime startup path.
- [x] Add tests and fixtures:
  - [x] New parser fixture: `tests/fixtures/gemini-session.json`.
  - [x] New parser tests: `tests/gemini-parser_test.ts`.
  - [x] New ingestion runner coverage in `tests/provider-ingestion_test.ts`.
  - [x] Update config/launcher/CLI/main tests for Gemini roots/env wiring.

## Verification

- `deno check main.ts main_test.ts apps/**/*.ts shared/**/*.ts tests/**/*.ts`
- `deno test --allow-read --allow-write=.kato tests/runtime-config_test.ts tests/daemon-launcher_test.ts tests/daemon-main_test.ts tests/daemon-cli_test.ts tests/provider-ingestion_test.ts tests/gemini-parser_test.ts tests/fixtures_port_test.ts`

## Notes

- Canonical Gemini conversation source remains the original provider files.
- Session discovery filters for `session-*.json` files and parses `sessionId`
  from file content.
- Workspace/project-name resolution enhancements remain follow-up work.
