---
id: 2u9ft5zhdgk95i92tng1vn9
title: 'Release Notes v0.2.1'
desc: ''
updated: 1772776020218
created: 1772776020218
---

# kato v0.2.1 (2026-03-05)

UX-focused release that improves export naming consistency and makes daemon
behavior on Windows more predictable.

## Highlights

- Username-aware output templating now supports `{username}` in both
  `filenameTemplate` and `defaultOutputDir`.
- New workspace toggle
  `markdownFrontmatter.addParticipantUsernameToHeadings` lets user-message
  headings use the resolved username instead of generic `User`.
- Frontmatter `participants` now emit plain usernames for user entries (for
  example `djradon`) instead of `user.djradon`.
- Windows daemon startup is more reliable via detached `Start-Process` launch
  semantics.
- Status marks stale daemons faster by tightening heartbeat staleness detection
  from 30s to 11s.
- Fatal daemon startup/runtime failures now emit clearer critical diagnostics to
  improve troubleshooting.

## Notable Behavior Updates

Username resolution for output templating now follows:

1. `participants.workspaceUsernames[workspaceId]`
2. `participants.defaultUsername`
3. `unknown-user`

Additional behavior changes:

- `defaultOutputDir` now accepts the same template tokens as
  `filenameTemplate`, including `{username}`.
- `addParticipantUsernameToHeadings` defaults to `false` (opt-in behavior).
- Tooling that parses frontmatter participants should expect plain usernames
  without the `user.` prefix.

## Release Packaging

- Source-only release (`v0.2.1`).
- Prebuilt binaries remain deferred to the distribution hardening track.
