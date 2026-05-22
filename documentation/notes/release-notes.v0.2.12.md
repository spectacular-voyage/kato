---
id: uggvjx1gr3m7kt2apvzdj4h
title: 'Release Notes v0.2.12'
desc: >-
  More resilient Kato Web startup, faster source launches, Dendron link
  normalization, and public documentation/site updates.
updated: 1775747849447
created: 1775747849447
---

## Summary

`v0.2.12` is a Kato Web reliability and release/docs cleanup release.
`kato web start` now treats the configured port as a preference, falls back to
an available port when needed, reports the actual runtime URL in status output,
skips unnecessary source builds, and captures startup logs for failed launch
diagnostics. Markdown recording appends also normalize existing body links when
Dendron wikilink mode is enabled later. The repo now has a public hand-authored
site under `docs/`, while the internal Dendron vault lives under
`documentation/`.

## User-facing Changes

- `kato web start` now scans upward from the configured Kato Web port and uses
  the first available port instead of failing just because the preferred port is
  already occupied.
- WSL2 web startup performs a best-effort Windows localhost listener probe, so
  a Windows-owned browser-visible `127.0.0.1` port can be skipped from WSL.
- `kato web status` and aggregate `kato status` now report the actual running
  or stale web URL from the web status heartbeat instead of always showing the
  configured preferred URL.
- Source checkout web launches skip `vite build` when the Fresh output is
  already current, and `kato web start` now prints startup timing for build,
  launch, and heartbeat acknowledgement.
- Detached Kato Web startup stdout/stderr are captured under the Kato web log
  directory, and startup acknowledgement failures include those log paths plus
  recent output when available.
- Kato Web now autofocuses the login username field and labels the header as
  `kato web console v<version>`.
- Existing markdown recording files are normalized through the current link
  policy during append, so legacy standard links can collapse to Dendron
  wikilinks after a workspace later enables Dendron wikilink mode.
- The README install/upgrade examples now use the `latest` npm dist-tag
  explicitly and include a short upgrade check with `kato --version`.
- A public Kato landing page was added under `docs/` with brand assets,
  install/quickstart copy, compatibility notes, and links back to the project.

### Upgrade notes

- `kato-web-config.yaml` still stores the preferred host/port. When startup
  falls back to another port, the config file is not rewritten; use
  `kato web status` to see the actual URL.
- Kato Web startup may create/truncate
  `~/.kato/web/logs/startup.stdout.log` and
  `~/.kato/web/logs/startup.stderr.log` during detached launches.
- Source contributors should use `documentation/notes/` for internal Dendron
  notes. `docs/` is now reserved for the public site/GitHub Pages output.

## Developer-oriented Changes

- The internal Dendron vault moved from `dev-docs/` to `documentation/`, and
  historical conversation/task/review note bulk was pruned from the main repo
  after being moved to the separate developer archive.
- Release tooling and workflow references now point at
  `documentation/notes/release-notes.v<version>.md` for GitHub Release bodies
  after Dendron frontmatter stripping.
- npm wrapper and platform package metadata now use the public Kato homepage
  URL, `https://spectacular-voyage.github.io/kato/`.
- Web dependencies were refreshed to Fresh `2.3.3`, Fresh Vite plugin `1.1.2`,
  Preact `10.29.2`, and Vite `7.3.3`, clearing the high-severity audit
  advisories in the release gate.
- The web endpoint resolution used by `kato status` and `kato web status` is
  shared, keeping running/stale/configured URL precedence consistent.
- Startup heartbeat fallback uses the injected runtime clock, and Windows host
  port probes have a timeout-backed abort to avoid indefinite hangs.
- Tests were added or expanded for web port fallback, WSL host-port probing,
  source build skipping, startup log redirection, startup diagnostics, web
  status URL reporting, login focus/error rendering, npm package metadata, and
  Dendron existing-body link normalization.
