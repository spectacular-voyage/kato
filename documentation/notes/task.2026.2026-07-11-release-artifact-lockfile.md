---
id: task-2026-07-11-release-artifact-lockfile
title: Release Artifact Lockfile
desc: Restore the transitive Vite lock entry required by frozen release artifact builds.
updated: 1783835546000
created: 1783835546000
---

## Goal

Make the v0.2.14 manual release artifact workflow pass its frozen Kato Web install after the Vite 7.3.6 security update.

## Summary

The ordinary CI gate validates the root and web dependency graphs separately, but the binary artifact builder additionally runs `deno install --frozen` from `apps/web`. Deno 2.8 requires the Fresh Vite plugin's transitive `npm:vite@^7.1.4` resolution to remain represented in `apps/web/deno.lock`; the previous Vite lock refresh retained Vite 7.3.6 itself but dropped that transitive specifier.

## Discussion

The failure reproduces locally with the same Deno 2.8.x toolchain used by the release workflow. The dependency version is already correct and patched, so this is a lockfile completeness issue rather than a package-version change.

## Open Issues

- None.

## Decisions

- Regenerate the Kato Web lockfile with Deno 2.8 rather than editing its dependency graph by hand.
- Preserve Vite 7.3.6 and add only the lock metadata required by the frozen installer.
- Add the exact frozen Kato Web install to the ordinary CI gate so an incomplete transitive lock graph fails before release artifact generation.
- Validate the exact frozen install and the artifact builder path in addition to the ordinary CI gate.

## Contract Changes

- None. Runtime, web, and persisted-data contracts are unchanged.

## Testing

- Run `deno install --frozen` from `apps/web`.
- Run the binary artifact builder using its normal frozen install path.
- Run `deno task ci`.

## Non-Goals

- Do not change the selected Vite version.
- Do not weaken or remove frozen lockfile enforcement in release automation.

## Implementation Plan

- [x] Reproduce the release artifact failure with Deno 2.8.x.
- [x] Refresh and inspect the Kato Web lockfile.
- [x] Validate frozen install, artifact generation, and the full CI gate.
- [x] Update release documentation.
