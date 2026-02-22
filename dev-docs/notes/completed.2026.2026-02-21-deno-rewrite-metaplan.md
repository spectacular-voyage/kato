---
id: 8carvto28quwlcocd93iybw
title: 2026 02 21 Deno Rewrite Metaplan
desc: ''
updated: 1771724905341
created: 1771724604223
---


## Scaffold Status (2026-02-22)

- [x] Create a new blank repo and run `deno init`.
- [x] Establish a Deno-oriented `.gitignore`.
- [x] Establish bootstrap quality gates (`fmt` / `lint` / `test` / CI).
- [x] Configure a Dendron self-contained vault for dev notes.
- [x] Embed old `stenobot` working tree (gitignored) for reference.
- [x] Develop starter dev documentation:
  - `dev.general-guidance`
  - `dev.security-baseline`
  - `dev.feature-ideas`
  - `dev.deno-daemon-implementation`
- [x] Create `CLAUDE.md`, `GEMINI.md`, and `CODEX.md` that reference `dev.general-guidance`.
- [x] Start MVP epic planning/sequencing note focused on library selection:
  - CLI framework
  - OpenTelemetry
  - Sentry integration checkpoint
  - OpenFeature decision point
- [x] Port existing parser fixtures into Deno test structure (`tests/fixtures/*`).
- [x] Expand monorepo skeleton into `apps/{daemon,web,cloud}` with `shared/src` contracts.

## Next Build Step

- Port parser behavior tests from `stenobot/tests/*.test.ts` into Deno-native parser tests.
