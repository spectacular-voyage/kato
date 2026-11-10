---
id: ucnzueyh1pqzv5hlyv5m7pf0
title: 'Release Notes v0.2.19'
desc: Kato's binaries now embed Deno 2.9.8 instead of 2.8.3, picking up TLS, npm, and compile security fixes, plus in-range dependency updates.
updated: 1794332149132
created: 1794332149132
---

## Summary

`v0.2.19` is a maintenance release. Kato's binaries are now built on Deno 2.9.8, the current release of the Deno 2.9 long-term support line, instead of 2.8.3. The 2.8 line stopped getting fixes after 2.8.3 (2026-06-11), so `v0.2.18` and earlier embed a runtime without the fixes below. Dependencies are updated to their latest releases within their current major versions.

There are no feature or behavior changes.

## User-facing Changes

- Security fixes from the embedded Deno runtime (2.9.8, 2026-10-21):
  - TLS no longer trusts the compromised eMudhra certificate authorities.
  - npm package link names are validated.
  - Compiled programs check read permission for dynamically imported local files.
  - X.509v1 certificate handling matches OpenSSL.
- Dependency updates within their major versions: `@std/cli`, `@std/http`, `@std/path`, and `@std/yaml`, and for Kato Web, Preact 10.29.8 and Vite 7.3.8.

### Upgrade notes

- No config or data migration.

### Looking ahead

Kato Web's framework (Fresh 2) is no longer maintained, and the Deno runtime's developers have announced that its development ends after a year of fix releases (about October 2027). Kato will move Kato Web off Fresh first and later to another runtime, keeping the same install channels. No action is needed from users.

## Developer-oriented Changes

- CI resolves Deno `v2.9.x`; the release workflow pins exactly `2.9.8`. The cli, daemon, and web lockfiles are regenerated with 2.9.8, which keys npm peer dependencies differently.
- A new CI job runs the root suite and the Kato Web tests on `windows-latest` and `macos-latest`. Baseline: 978 tests pass on macOS; 977 pass and 1 is ignored on Windows (legacy colon storage keys).
- New `deno task test:web` runs `apps/web/tests` with scoped permissions; `deno task ci` and the Ubuntu CI job run it.
- Web tests use the production `preact-render-to-string` range (`^6.6.3`) instead of an exact 6.6.6, which would have pulled Fresh's copy down.
- Dropped the unused `@preact/signals` import-map entry from `apps/web`.
- `loglayer` 9.1.0 to 9.4.0. The runtime loads it through a dynamic `import()`, which compiled binaries likely do not include, so release builds probably use the JSONL fallback writer (an open issue in the platform migration task).
- GitHub Actions: `actions/checkout` v7, `actions/setup-node` v7, `codecov/codecov-action` v7, and `osv-scanner-action` 2.3.8. CodeQL runs only through the repository's default setup (now with the `remote_and_local` threat model); `codeql.yml` is removed. OSV-Scanner runs again on pushes and pull requests.
- `dev.general-guidance` now asks new code to prefer Web-standard and `node:*` APIs over `Deno.*` and to avoid new Fresh-specific APIs. See [[dev.decision-log]] "Platform Direction After Deno and Fresh" and [[task.2026.2026-11-10-platform-migration]].
