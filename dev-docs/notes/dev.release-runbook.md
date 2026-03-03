---
id: zskc5s6r8d1khexmq6q6q7t
title: Release Runbook
desc: ''
updated: 1772551839242
created: 1772551839242
---

## Purpose

Developer-facing release process for `kato`.

For `v0.2.0`, release is intentionally source-only. Binary artifact publishing
is deferred to a follow-up hardening track.

## v0.2.0 Source-Only Release

### Version Policy

- `deno.json` is the canonical version source for `kato --version`.
- Release tag and `deno.json` version must match:
  - tag: `v0.2.0`
  - version field: `0.2.0`

### Release Steps

1. Confirm release commit is on `main` and CI is green.
2. Run full local quality gate:

```bash
deno task ci
```

3. Verify version:

```bash
deno run -A apps/daemon/src/main.ts --version
```

Expected output includes `kato 0.2.0`.

4. Create and push annotated tag:

```bash
git tag -a v0.2.0 -m "kato v0.2.0"
git push origin v0.2.0
```

5. Create GitHub release from `v0.2.0`.
6. In release notes, state explicitly:
   - source-only release
   - compiled binaries are deferred

### Verification Checklist

- [ ] `deno.json` version is `0.2.0`.
- [ ] `kato --version` reports `0.2.0`.
- [ ] `deno task ci` passed for release commit.
- [ ] Git tag `v0.2.0` exists and points to release commit.
- [ ] GitHub release exists from `v0.2.0`.
- [ ] Release notes mention binaries are deferred.

## Immediate Follow-Up Hardening (Post-v0.2.0)

- [ ] Enable branch protection on `main` requiring CI checks.
- [ ] Add Dependabot for GitHub Actions.
- [ ] Add coverage artifact generation and patch coverage gating.
- [ ] Add binary release workflow(s) with scoped `deno compile` permissions.
