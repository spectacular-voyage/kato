---
id: lymgj8vtkexbx5px8xu4s32j
title: 'Release Notes v0.2.7'
desc: >-
  Web restart, safer workspace bootstrap, clickable summary navigation, and
  initial website/brand groundwork.
updated: 1773494816990
created: 1773416480457
---

`v0.2.7` is a small but useful ergonomics release: faster local web lifecycle
control, safer workspace bootstrap for shared repos, and a first pass at
website/brand groundwork.

Primary changes:

- added `kato web restart` so the local web console can be bounced with one
  command
- changed `kato workspace register` to restart the daemon automatically when
  registration expands `allowedWriteRoots`, with `--no-restart` available to
  opt out
- fixed the macOS-reported `workspace register alias=<alias>` compatibility
  bug by recognizing bare `alias=...` tokens instead of treating them as
  positional arguments
- changed `kato workspace init` to generate and write `workspaceId`
  immediately, reducing first-register churn in shared repos
- made Summary metrics clickable so Sessions, Recordings, and Workspaces are
  one click away
- added initial website/brand groundwork, including static logo/wordmark
  assets, asset helpers/redirects, and new planning/task-template docs for
  site work

Upgrade notes:

- if you previously relied on registering a workspace without restarting the
  daemon, use `kato workspace register --no-restart` to preserve that behavior
- new workspaces initialized with `kato workspace init` now get a committed
  `workspaceId` immediately; existing configs without one still backfill on
  first register
- `kato web restart` is now the quickest way to reload the local web operator
  console after config or code changes

Acknowledgements:

- this cut combined CLI/runtime tightening with website planning and continued
  iteration using Codex and CodeRabbit
