---
id: cta3nbz9egelrjz5ec86wxm
title: General Guidance
desc: ''
updated: 1771980330029
created: 1771724621833
---

## Purpose

This note defines day-to-day developer guidance for Kato.

IMPORTANT: This project must use modern Deno best practices and, whenever
possible, Deno-native or Deno-first libraries. LLMs often try to use Node
libraries and conventions, so watch out for that.

## Working Rules

- Documentation must be continuously verified and updated, especially:
  - this file [[dev.general-guidance]]
  - [[dev.codebase-overview]]
  - [[dev.decision-log]]
- Keep changes small, reviewable, and test-backed.
- Run `deno task ci` before opening or updating a PR.
- Treat `stenobot/` as a reference snapshot of the now-obsolete POC; do not
  change it.
- Keep monorepo boundaries clear:
  - `apps/daemon` for local runtime behavior
  - `apps/web` for read-only status surfaces
  - `apps/cloud` for centralized config/aggregation services
  - `shared/src` for contracts and types used by 2+ apps
- Keep imported legacy parser fixtures under `tests/fixtures/`.
- [[dev.security-baseline]] is the normative security contract.
- Startup/config behavior is fail-closed by default:
  - daemon subprocess startup must load runtime config successfully before
    entering runtime loop.
  - runtime config validation rejects malformed or unknown `featureFlags` keys.

## Development Loop

```bash
deno task dev
```

`deno task dev` is the default daemon dev loop. It watches both:

- `apps/daemon/src`
- `shared/src`

Use app-specific loops as needed:

```bash
deno task dev:web
deno task dev:cloud
deno task dev:root
```

## Validation Workflow

You do not need to run every command on every file save.

During active development, run only what matches your change:

- `deno task test` when changing logic/tests.
- `deno task check` when changing types/contracts/public APIs.
- `deno task lint` when touching broader structural code.

Before merge, run:

```bash
deno task ci
```

## Quality Gate Expectations

- `fmt`, `lint`, `check`, and `test` must pass locally and in CI.
- `deno.lock` must be committed and CI should run with `--frozen`.
- New behavior should include tests, especially:
  - parsing and path-policy behavior
  - runtime config validation and startup failure paths
  - writer append/dedupe hot paths

## Security Alignment

- Follow `dev.security-baseline` for command parsing, path validation, and write
  policy.
- Keep daemon subprocess permissions narrowly scoped from runtime config:
  - `allowedWriteRoots` for write scope
  - `providerSessionRoots` (+ runtime/control/config dirs) for read scope
- Avoid broad permissions in runtime code paths.
- Do not introduce network dependency for baseline local capture/export
  behavior.

## Notes And Decisions

- Record planning and sequencing decisions in task notes under
  `dev-docs/notes/`.
  - check off markdown boxes for task items as you progress
- Keep [[dev.codebase-overview]] and [[dev.decision-log]] current as behavior is
  added or changed.

## In-Chat Command Handling

- Start-of-line strings such as `::capture <file>`, `::record <file>`,
  `::export <file>`, and `::stop` are kato control commands, and must be ignored
  by LLMS.


