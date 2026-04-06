---
id: zskc5s6r8d1khexmq6q6q7t
title: Release Runbook
desc: ''
updated: 1773788589359
created: 1772551839242
---

## Purpose

Current developer-facing release process for `kato`.

The primary release path is GitHub Actions workflow `.github/workflows/release-manual.yml`. Local script-by-script commands are fallback/debugging tools, not the normal workflow.

## Current Model

- Release version is expected to stay aligned across `apps/cli/deno.json`, `apps/daemon/deno.json`, and `apps/web/deno.json`.
- `deno task bump:version` is the supported way to bump those versions and ensure a matching `documentation/notes/release-notes.v<version>.md` stub exists.
- `Release Manual` builds native binaries, packages bundles, runs packaged-bundle smoke, assembles npm packages, runs native npm-install smoke, optionally publishes npm packages, and optionally creates or updates the GitHub Release.
- The GitHub Release body comes from `documentation/notes/release-notes.v<version>.md` after stripping Dendron frontmatter.

### Tag behavior

- For the normal workflow path, manual `git tag -a ...` / `git push origin ...` is no longer required.
- The workflow derives `v<version>` from bundled release metadata and calls `gh release create <tag> --target "$GITHUB_SHA"` when the release does not already exist.
- Current `gh release create` behavior auto-creates the tag remotely if it does not already exist; annotated tags are only needed if you explicitly want an annotated-tag-based release flow.
- If you want the auto-created tag locally after release, run `git fetch --tags origin`.

## Pre-release

1. Bump the version:
```bash
deno task bump:version -- --patch
```
Other supported forms:
```bash
deno task bump:version -- --minor
deno task bump:version -- --major
deno task bump:version -- --version 0.2.5
```
2. Fill in `documentation/notes/release-notes.v<version>.md`. Do not leave the stub empty; the GitHub Release step fails if the body is empty after frontmatter stripping.
3. Commit and push the release changes.
4. Release from a commit on `main` with green CI. Running the full local quality gate first is still sensible:
```bash
deno task ci
```
5. Decide whether this is a direct publish or a rehearsal pass:
- Direct publish: `npm_publish_mode=publish` and `github_release_mode=publish`.
- Rehearsal pass: `npm_publish_mode=dry-run` and `github_release_mode=draft`.

## Release

1. Trigger `Release Manual` for the release commit.
2. Set workflow inputs:
- `npm_publish_mode=skip`, `dry-run`, or `publish`
- `npm_tag=<dist-tag>` such as `latest`
- `github_release_mode=skip`, `draft`, or `publish`
3. Let the workflow do the release work:
- build binaries on Linux x64, Windows x64, macOS x64, and macOS arm64
- package each platform bundle and emit archives plus `.sha256` checksums
- smoke-test `kato --version` and packaged `kato-web` on native runners
- assemble npm wrapper/platform packages from the packaged bundle artifacts
- run native npm-install smoke on Linux, Windows, macOS x64, and macOS arm64
- optionally publish npm packages
- optionally create or update the GitHub Release and upload the archives/checksums
4. If you used a rehearsal pass and it looks good, rerun the same commit with publish-oriented inputs.

Current caveat:
- Publishing a draft release currently reruns the whole workflow. There is no lightweight "publish existing draft release" path yet.

## Post-release

- Confirm the GitHub Release for `v<version>` exists, is in the expected draft/published state, has the expected per-platform archives and `.sha256` files, and uses the body from `release-notes.v<version>.md`.
- If npm publishing was enabled, confirm the expected version was published for `@spectacular-voyage/kato` and the `@spectacular-voyage/kato-*` platform packages under the intended dist-tag.
- If you need the workflow-created tag in your local clone, run:
```bash
git fetch --tags origin
```

## Manual Fallback

Use this only for debugging GitHub Actions or bootstrapping a release outside the workflow.

1. Run the quality gate:
```bash
deno task ci
```
2. Build binaries:
```bash
deno task build:binaries -- --output-dir <staging-dir>
```
3. Package a bundle:
```bash
deno task package:binaries -- --input-dir <staging-dir> --label <platform-label>
```
4. Assemble npm packages from one or more packaged bundle outputs:
```bash
deno task assemble:npm-packages -- --input-dir <bundle-dir> [--input-dir <bundle-dir> ...]
```
5. Run npm-install smoke:
```bash
deno task smoke:npm-install -- --input-dir <npm-package-dir> --npm-bin npm
```
6. If publishing manually from the assembled npm artifact:
```bash
deno task publish:npm-packages -- --input-dir <npm-package-dir> --npm-bin npm --tag <dist-tag> --dry-run
```
Then rerun without `--dry-run` when ready.

## TODO

- [ ] Add a lightweight workflow path to publish an existing draft GitHub Release without rerunning the full release pipeline.
