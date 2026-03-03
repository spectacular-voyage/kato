---
id: 0qjcf9cphpnfylmmjsp6v10
title: 2026 02 22 CI CD
desc: ''
updated: 1772548248746
created: 1771831193268
---

## Goal

Maintain reliable CI and define a repeatable release path for `kato`, with
explicit separation between what is required for source-only `v0.2.0` and what
is deferred to post-`v0.2.0` hardening.

## Release Strategy Split

### Track A (Active): Source-Only `v0.2.0`

- Keep CI quality gate on PR + `main`.
- Set and ship semantic version (`0.2.0`) from `deno.json`.
- Publish a GitHub release from tag/source only (no compiled binaries).
- Document runbook and verification steps.

### Track B (Deferred): Binary Distribution + Expanded CI Hardening

- Manual and/or tag-triggered binary workflows (`deno compile`).
- Coverage artifact and patch-gate integration (Codecov or equivalent).
- Dependabot for GitHub Actions.
- GitHub `release` environment and required reviewers for binary releases.

## Current State

- ✅ `.github/workflows/ci.yml` exists and runs `deno task ci` on PR + `main`.
- ✅ `deno.lock` is committed and CI is frozen via task-level flags.
- ✅ `deno.json` now carries explicit version `0.2.0`.
- ❌ No release workflow YAML exists yet (intentional for source-only `v0.2.0`).
- ❌ Branch protection / release-environment policies are not yet configured.

## Track A: Source-Only `v0.2.0` (Required Now)

### Required Steps

1. Ensure `main` is green on CI.
2. Confirm `deno.json` version is `0.2.0`.
3. Run local validation before tagging:

```bash
deno task ci
```

4. Create and push annotated tag:

```bash
git tag -a v0.2.0 -m "kato v0.2.0"
git push origin v0.2.0
```

5. Create GitHub release from `v0.2.0` tag with notes.
6. Explicitly state in release notes: binary artifacts are deferred.

### Verification Checklist

- [ ] Tag exists as `v0.2.0`.
- [ ] `deno.json` version is `0.2.0`.
- [ ] `deno task ci` passed for release commit.
- [ ] GitHub release exists from tag/source.
- [ ] Release notes state that binaries are deferred.

## Track B: Post-`v0.2.0` Hardening (Deferred)

### CI Quality Hardening

- [ ] Add coverage artifact generation to CI (`lcov`).
- [ ] Configure patch-coverage quality gate.
- [ ] Add coverage badge to README.
- [ ] Add Dependabot for GitHub Actions updates.

### Release Automation Hardening

- [ ] Create `.github/workflows/release-manual.yml` for multi-platform binaries.
- [ ] Define scoped `deno compile` permission flags aligned with launcher scoping.
- [ ] Configure GitHub Environment (`release`) with required reviewers.
- [ ] Evaluate tag-triggered binary release workflow after stable manual releases.

### Governance Hardening

- [ ] Enable branch protection on `main` requiring CI checks.
- [ ] Require green status checks before merge.

## Notes

- This file intentionally no longer treats binary artifacts as a requirement for
  `v0.2.0`.
- Binary release work remains important, but it is intentionally sequenced after
  first source-only release completion.
