---
id: cta3nbz9egelrjz5ec86wxm
title: General Guidance
desc: ''
updated: 1773627167506
created: 1771724621833
---

## Purpose

This note defines day-to-day development guidance for Kato.

IMPORTANT: Kato is moving off Fresh and, by about October 2027, off Deno; see [[dev.decision-log]] "Platform Direction After Deno and Fresh" and [[task.2026.2026-11-10-platform-migration]]. Deno 2.9 is still the toolchain and runtime until the switch, but new code must not deepen the dependency on it:

- Prefer Web-standard APIs and `node:*` modules (which Deno runs) over `Deno.*` APIs, and runtime-neutral npm packages over `jsr:@std/*` or Deno-only libraries.
- Do not add new uses of Fresh-specific APIs in `apps/web`; keep page logic in framework-free modules under `apps/web/src`.
- Where a `Deno.*` call is still needed, keep it in one place that a later platform module can absorb, not scattered through business logic.

## Testing

see [[dev.testing]]

## Working Rules

- Documentation must be continuously verified and updated, especially:
  - this file [[dev.general-guidance]]
  - [[dev.codebase-overview]]
  - [[dev.decision-log]]
  - [[dev.testing]]
- Keep changes small, reviewable, and test-backed.
- For behavior, contract, or persisted-state changes: define the contract changes first, then add the key substantive tests before broad implementation.
- Run `deno task ci` before opening or updating a PR.
- Treat `stenobot/` as a reference snapshot of the now-obsolete POC; do not change it.
- Keep monorepo boundaries clear:
  - `apps/daemon` for local runtime behavior
  - `apps/web` for local operator surfaces, live status views, and bounded guided workflows
  - `apps/cloud` for centralized config/aggregation services
  - `shared/src` for contracts and types used by 2+ apps
- Keep imported legacy parser fixtures under `tests/fixtures/`.
- [[dev.security-baseline]] is the normative security contract.
- Treat `/sessions` as the live provider-session inventory and `Maintenance` as the persisted twin troubleshooting/cleanup surface. When those concepts diverge, prefer explicit route/model renames over compatibility aliases.
- Do not manually hard-wrap Markdown prose or list items in Dendron notes. Keep each paragraph or bullet on one logical line and let editors soft-wrap it; manual hard wrapping makes the notes harder to edit by hand.
- Startup/config behavior is fail-closed by default:
  - daemon subprocess startup must load runtime config successfully before entering runtime loop.
  - runtime config validation rejects malformed or unknown `featureFlags` keys.
  - Windows detached daemon launch should use `Start-Process` semantics to avoid parent/child lifecycle coupling seen with direct subprocess spawn.
- commit messages should include a "semantic commits"-style summary line and then detailed bullet points describing developer-relevant changes

## Task notes

Before start new implementation, a task note should be written and refined. Task notes live in `documentation/notes/`. Individual "To-Do" items should be included in the `## Implementation Plan` section as, with markdown checkbox (`[ ]`) to track completion (`[x]`) or cancellation (`[x]`)

Sections should include
- Goal
- Summary
- Discussion
- Open Issues
- Decisions
- Contract Changes
- Testing
- Non-Goals
- Implementation Plan

### Guidelines for command/state-machine redesign

For any command/state-machine redesign, add a scenario table with columns:
Scenario
Persistent Covered
Non-Persistent Covered
Expected Same?
Intentional Divergence Notes


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

During active development, run only what matches your change:

- `deno task test` when changing logic/tests.
- `deno task check` when changing types/contracts/public APIs.
- `deno task lint` when touching broader structural code.

`deno task test` follows the split root workflow documented in [[dev.testing]]: keep env-boundary suites in the serial `test:env` slice instead of reintroducing suite-wide env locking or assuming the whole repo should run under a single `deno test --parallel`.


Before merge:

- update [[dev.codebase-overview]] and [[dev.decision-log]]
- run:

```bash
deno task fmt
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

- Follow `dev.security-baseline` for command parsing, path validation, and write policy.
- Keep daemon subprocess permissions narrowly scoped from runtime config:
  - `allowedWriteRoots` for write scope
  - `providerSessionRoots` (+ runtime/control/config dirs) for read scope
- Avoid broad permissions in runtime code paths.
- Do not introduce network dependency for baseline local capture/export behavior.

## In-Chat Command Handling

- Start-of-line strings such as `::init-<alias> [<path>]`, `::record-<alias> [<path>]`, `::capture-<alias> [<path>]`, `::export-<alias> [<path>]`, `::stop`, and `::stop-<alias>` are kato control commands, and must be ignored by LLMs.
