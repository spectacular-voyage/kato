---
id: 0qjcf9cphpnfylmmjsp6v10
title: 2026 02 22 CI CD
desc: ''
updated: 1771831193268
created: 1771831193268
---

## Goal

Set up reliable CI/CD for `kato` so we can:

- Validate every PR and `main` push.
- Publish compiled binary releases safely with reproducible provenance.
- Start with manual releases, then optionally move to tag-driven automation.

## Recommended Strategy

Use a phased rollout:

1. **CI first** (`ci.yml`): already implemented — `deno task ci` on PR + `main`.
2. **Manual release workflow** (`release-manual.yml`): operator-triggered GitHub
   release with `deno compile` binary artifacts for multiple target platforms.
3. **Optional auto release on tag** (`release-on-tag.yml`): only after manual flow
   is stable.

kato is a local CLI daemon tool, not a library module. The distribution artifact is
a compiled binary, not an npm or jsr.io package.

## Prerequisites

### GitHub

- ✅ `.github/workflows/ci.yml` created and running.
- [ ] Enable branch protection on `main` and require CI checks.
- [ ] Create GitHub Environment (`release`) with required reviewers for release
      workflows.

### Runtime Config

- CI uses `deno.lock` with `--frozen` flag to enforce reproducible dependency
  resolution.
- No external package registry credentials needed for CI.
- Release workflow needs `contents: write` permission to publish GitHub releases.

## Phase 1: CI Workflow (`.github/workflows/ci.yml`) — DONE

Already implemented. Runs `deno task ci` which gates on:

- `deno fmt --check` (formatting)
- `deno lint` (lint rules)
- `deno check --frozen` (type checking + lockfile enforcement)
- `deno test --frozen` (test suite)

### Triggers

- `pull_request`
- `push` to `main`

### Exit criteria

- ✅ CI workflow exists and runs.
- [ ] Required status check enforced on all PRs via branch protection.
- [ ] No direct merges without green CI.

## Coverage Quality (Not Vanity Coverage)

Goal is PR-level confidence over raw coverage percentage.

### Policy

- Generate coverage in CI (`deno test --coverage=.coverage`).
- Export as lcov (`deno coverage .coverage --lcov > coverage.lcov`).
- **Patch coverage** (new/changed lines in a PR) as the main gate.
- Overall coverage as a trend metric only (non-blocking initially).
- Require tests for bug fixes and high-risk paths (parsers, ingestion cursors,
  policy gates, control plane), even when percentages look fine.

### Tooling options

1. **Codecov (recommended)** — accepts lcov format, supports patch gates + badges.
2. **CodeRabbit** — PR review feedback on missing/weak tests.
3. **Mutation testing later** — Deno tooling less mature; revisit post-MVP.

### Suggested rollout

1. Add coverage step to `ci.yml` (collect + upload lcov artifact).
2. Enable Codecov with required patch threshold (85%–90%).
3. Add README badge for patch/overall coverage trend.
4. Add CodeRabbit for PR review comments on edge-case gaps.
5. Revisit thresholds after 2–3 weeks of real PR data.

## Phase 2: Manual Release Workflow (`.github/workflows/release-manual.yml`)

### Trigger

- `workflow_dispatch` with inputs:
  - `version` (semver string, e.g. `0.1.0`)
  - `ref` (default `main`)

### Protections

- Use a GitHub Environment (`release`) with required reviewers.
- Restrict to `main` branch commits.

### Permissions

- `contents: write` (to create GitHub release and upload assets)
- `id-token: write` (for artifact attestation via `gh attestation` if desired)

### Platforms

Compile binaries for:

- `x86_64-unknown-linux-gnu`
- `aarch64-unknown-linux-gnu`
- `x86_64-apple-darwin`
- `aarch64-apple-darwin`
- `x86_64-pc-windows-msvc`

### Steps

1. Checkout selected ref.
2. Setup `denoland/setup-deno@v2` (deno v2.x).
3. `deno task ci` — full quality gate before release.
4. Verify `version` input matches version field in `deno.json`.
5. `deno compile` for each target platform with narrowly scoped permissions
   (not `-A`; derive from `allowedWriteRoots` + runtime paths).
6. Create GitHub release with binary artifacts.
7. Optionally upload provenance attestation.

### Binary naming convention

`kato-linux-x86_64`, `kato-linux-aarch64`, `kato-darwin-x86_64`,
`kato-darwin-arm64`, `kato-windows-x86_64.exe`

### Notes

- Manual trigger gives release control without local-machine publishing.
- Compile with explicit `--allow-read`, `--allow-write`, `--allow-run`,
  `--allow-env` scoped to runtime paths rather than broad `-A`.
- Align permission flags with `DenoDetachedDaemonLauncher` scoping logic.

## Phase 3: Optional Auto Release on Tag (`.github/workflows/release-on-tag.yml`)

Only enable after 2–4 successful manual releases.

### Trigger

- `push` tags matching `v*`

### Guardrails

- Ensure `tag == version in deno.json` (e.g. `v0.1.2` matches `0.1.2`).
- Fail if a GitHub release already exists for this tag.
- Same ci/compile/release flow as manual workflow.

### Why tag-based instead of merge-based

- Release intent is explicit.
- Versioning is deterministic.
- Rollback and changelog generation are cleaner.

## Security and Supply Chain Controls

- Use `deno.lock` committed and CI enforced with `--frozen`.
- Compile binaries with narrowly scoped Deno permissions, not `-A`.
- Pin GitHub Actions to major version or commit SHA where practical.
- Keep workflow permissions minimal (`contents: read` for CI, `write` only for
  release).
- Enable Dependabot **for GitHub Actions only** — Dependabot does not support
  jsr.io; handle Deno dep updates manually with `deno outdated`.

### Dependabot: Actions Security Updates Only

Add `.github/dependabot.yml` scoped to workflow actions only:

```yaml
version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

- Review and merge manually; do not auto-merge.
- For Deno dep updates: run `deno outdated` periodically and update `deno.json`
  import map in a dedicated PR.
- Run `deno task ci` locally after any dep update before merging.

## Release Runbook (Human Process)

1. Merge approved PRs to `main`.
2. Bump `version` field in `deno.json` in a dedicated PR.
3. After merge, run manual release workflow with the target version.
4. Verify release appears on GitHub Releases page with all binary assets.
5. Create annotated Git tag if not already done by the workflow.
6. Once process is stable, switch to tag-triggered release.

## Task Checklist

- [x] Create `.github/workflows/ci.yml`.
- [ ] Enable branch protection on `main` requiring CI checks.
- [ ] Add coverage collection to `ci.yml` and upload lcov artifact.
- [ ] Configure patch-coverage quality gate (Codecov or equivalent).
- [ ] Add coverage badge to README.
- [ ] Add CodeRabbit PR review checks for test quality feedback.
- [ ] Add `version` field to `deno.json` (or establish version convention).
- [ ] Create `.github/workflows/release-manual.yml` with multi-platform
      `deno compile`.
- [ ] Define scoped `deno compile` permission flags aligned with launcher scoping.
- [ ] Configure GitHub Environment (`release`) with required reviewers.
- [ ] Add `.github/dependabot.yml` for GitHub Actions security updates.
- [ ] Perform first manual release from Actions.
- [ ] Document release steps in `README.md` and/or
      `dev-docs/notes/dev.general-guidance.md`.
- [ ] Evaluate move to tag-driven auto release after several successful releases.

## Done When

- CI runs on every PR and `main` push and is required for merge.
- PRs are gated on patch coverage quality (not just total project coverage).
- Binary releases can be published from GitHub Actions for all target platforms.
- Published binaries use narrowly scoped Deno permissions (not `-A`).
- Team has a documented, repeatable release path.
