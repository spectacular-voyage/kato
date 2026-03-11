---
id: 927i3bi6rjg1pr8ewgapv3h
title: 'Release Notes v0.2.2'
desc: ''
updated: 1773213213290
created: 1773213138648
---

# kato v0.2.2 (2026-03-11)

Web-and-observability release that adds a local authenticated dashboard,
expands operator workflows, and hardens CI/testing around the larger surface
area.

## Highlights

- New Kato Web local dashboard with authenticated Summary, Ingestion,
  Sessions, Recordings, Workspaces, Logs, Settings, and Maintenance pages.
- New `kato web` lifecycle commands: `init`, `start`, `stop`, and `status`,
  with explicit config bootstrap and startup acknowledgement handling.
- Live refresh now spans the main web surfaces, so daemon, session, recording,
  workspace, and log state updates without full-page reloads.
- User and workspace management are broader: settings now cover default
  username, workspace-specific username mappings, and `exclude-me`, while
  workspace registration can omit `--alias` and default to the folder name.
- Maintenance and observability are stronger: filtered operational/security log
  views, web-aware status reporting, recording activity rollups, and persisted
  session cleanup support even while the daemon is running.
- Test and CI coverage expanded significantly with more direct command/parser/
  runtime tests, parallel test execution, coverage artifact generation, and
  added CodeQL/OSV automation.

## Notable Behavior Updates

- Kato Web is explicitly opt-in and credentialed: run `kato web init` before
  `kato web start`, and provide credentials during init.
- Authenticated web pages preserve existing query/filter semantics while
  polling in the background instead of switching to client-owned mutation
  flows.
- `kato status` now surfaces web runstate/version alongside daemon, workspace,
  memory, recent-error, and session data.
- The UI now distinguishes active ingestion, discovered session inventory, and
  recording activity more clearly across Summary, Ingestion, Sessions, and
  Recordings.
- `clean --sessions` no longer requires stopping the daemon first.

## Release Packaging

- Source-only release (`v0.2.2`).
- Kato Web ships as a local Deno/Fresh app managed through `kato web ...`.
- Prebuilt binaries remain deferred to the distribution hardening track.
