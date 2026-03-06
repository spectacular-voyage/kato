---
id: 0qjcf9cphpnfylmmjsp6v10
title: 2026 02 22 CI CD
desc: ''
updated: 1772778893878
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

### Track B (Deferred): CI/Governance Hardening + Distribution Handoff

- Coverage artifact and patch-gate integration (Codecov or equivalent).
- Dependabot for GitHub Actions.
- Branch protection and required status checks.
- Release automation ownership moved to
  `task.2026.2026-03-05-distribution-solutions.md`.

## Current State

- ✅ `.github/workflows/ci.yml` exists and runs `deno task ci` on PR + `main`.
- ✅ `deno.lock` is committed and CI is frozen via task-level flags.
- ✅ `deno.json` now carries explicit version `0.2.0`.
- ❌ No release workflow YAML exists yet (intentional for source-only `v0.2.0`).
- ❌ Branch protection / release-environment policies are not yet configured.

## Closeout Split (2026-03-05)

- `Release Automation Hardening` is now tracked in
  `task.2026.2026-03-05-distribution-solutions.md`.
- This file retains CI/governance hardening ownership.
- Ownership includes CI quality gates/coverage/dependabot follow-ups.
- Ownership includes branch protection and required status checks.
- `Track A` source-only `v0.2.0` is complete and verified.

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

- [x] Tag exists as `v0.2.0`.
- [x] `deno.json` version is `0.2.0`.
- [x] `deno task ci` passed for release commit.
- [x] GitHub release exists from tag/source.
- [x] Release notes state that binaries are deferred.

## Track B: Post-`v0.2.0` Hardening (Split)

### CI Quality Hardening

- [x] Add coverage artifact generation to CI (`lcov`).
- [x] Configure patch-coverage quality gate.
- [x] Add coverage badge to README.
- [x] Add Dependabot for GitHub Actions updates.

### Release Automation Hardening (Moved)

- Moved to
  `task.2026.2026-03-05-distribution-solutions.md` under
  `Release Automation Hardening Intake From CI/CD Task`.
- This avoids split ownership while binary distribution work is being designed.

### Governance Hardening

- [d] Enable branch protection on `main` requiring CI checks.
- [d] Require green status checks before merge.

## Notes

- This file intentionally no longer treats binary artifacts as a requirement for
  `v0.2.0`.
- Binary release work remains important, but it is intentionally sequenced after
  first source-only release completion.
