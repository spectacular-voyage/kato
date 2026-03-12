---
id: 3ys9m14h2kifb6xf5dy26g8
title: 2026 03 11 Npmjs Install
desc: ''
updated: 1773295109426
created: 1773295109426
---

## Goal

Add an npmjs installation channel for Kato that installs prebuilt native
binaries with normal npm semantics, does not require Deno, does not compile on
the user machine, and preserves the current `kato` CLI surface.

## Summary

- npm should be the primary user-facing install/update channel, not a separate
  runtime architecture.
- The npm channel should reuse the native binaries already produced by the
  binary-distribution pipeline in
  [[task.2026.2026-03-11-binary-distributions]].
- Recommended package shape:
  - one thin top-level wrapper package
  - one platform package per supported OS/arch target
- Each platform package should contain:
  - `kato`
  - `kato-daemon`
  - `kato-web`
- npm should not download or compile binaries in `postinstall`.

## Discussion

Lots of likely Kato users already have Node/npm but not Deno. That makes npm a
strong primary install channel once the native binary story exists.

The important constraint is to keep npm from becoming a second build system.
The correct relationship is:

- GitHub/native-runner workflow builds the real binaries
- npm packages are assembled from those release artifacts
- npm install selects the correct prebuilt package for the user's platform
- the installed `kato` command still launches the same native executables as
  the direct-binary channel

### Recommended package model

Recommended package set:

- top-level package:
  - final public name: `kato`
- platform packages, for example:
  - `@spectacular-voyage/kato-win32-x64`
  - `@spectacular-voyage/kato-darwin-x64`
  - `@spectacular-voyage/kato-darwin-arm64`
  - `@spectacular-voyage/kato-linux-x64-gnu`

Recommended responsibilities:

- top-level wrapper package:
  - declares the public `bin` entry for `kato`
  - depends on the platform packages via `optionalDependencies`
  - contains a tiny Node launcher that resolves the installed platform package
    and `spawn()`s its packaged `kato` binary
- platform package:
  - declares matching `os`, `cpu`, and where needed `libc`
  - contains the native binaries and release metadata
  - does not contain business logic beyond packaging metadata

This model keeps install/uninstall inside npm's normal ownership model while
keeping Kato itself native.

Current local implementation status:

- `scripts/assemble-npm-packages.ts` generates:
  - wrapper package `kato`
  - platform packages such as `@spectacular-voyage/kato-linux-x64-gnu`
- `scripts/smoke-npm-install.ts` performs a local smoke of:
  - `npm pack`
  - temp-project install
  - `kato --version`
  - isolated `kato init`
  - isolated `kato web init`
  - isolated `kato web start`
  - HTTP probe of `/login`
  - `kato web status`
  - `kato web stop`

### Why not source install or postinstall download

The npm channel should not:

- run `deno compile` on the user machine
- download release artifacts in `postinstall`
- install a package that still requires Deno
- rebuild the Fresh web app locally

Reasons:

- installation becomes less deterministic
- corporate proxy and mirror behavior gets worse
- lockfile/repeatability gets worse
- uninstall behavior becomes ambiguous
- Kato would have two materially different install paths to debug

The npm package should be a packaging layer over the binary release artifacts,
not a new distribution architecture.

### Wrapper launcher behavior

The wrapper launcher should stay intentionally small:

- resolve the current platform package
- build the path to the packaged `kato` executable
- forward `argv`, `stdio`, exit code, and termination signal behavior
- fail with a clear message if no supported platform package is installed

It should not:

- reimplement Kato command parsing
- know how to launch `kato-daemon` or `kato-web` directly
- own runtime state under `~/.kato`

The runtime contract should stay the same as the direct-binary channel:

- `kato` is the public command
- `kato-daemon` and `kato-web` live as sibling executables for launcher
  discovery
- Kato state still lives under `~/.kato` or `KATO_RUNTIME_DIR`, not under npm's
  global install prefix

### Binary/package layout

Each platform package should carry the same minimal payload:

- `kato`
- `kato-daemon`
- `kato-web`
- `build-metadata.json`
- `bundle-metadata.json`
- `LICENSE`
- `README.md` or npm-specific short readme if size becomes a concern

The top-level wrapper should find the platform package by package name rather
than by fragile relative path guesses outside npm ownership.

Inside the platform package, the binaries should stay colocated so the current
launcher behavior can keep using sibling-binary discovery.

### Supported targets for the first npm cut

The npm channel should match the first real binary matrix, not promise more:

- Windows x64
- macOS arm64
- macOS x64
- Linux x64 glibc

Anything else should fail explicitly with a clear unsupported-platform error.

That means:

- Linux musl is not part of the first npm cut
- ARM Linux is not part of the first npm cut
- 32-bit targets are not part of the first npm cut

### Release and publish sequencing

The npm publish flow should sit on top of the binary workflow, not beside it.

Recommended sequence:

1. build platform binaries on native runners
2. package the native bundles
3. assemble npm wrapper/platform packages from those packaged outputs
4. run npm install smoke checks against the assembled packages
5. publish the npm packages
6. publish or undraft the GitHub release only after npm publishing passes

Why this order matters:

- npm versions are immutable once published
- native build failures should happen before registry publishing
- npm package contents should be traceable back to the exact release artifacts

## Open Issues

- Should the platform packages be published as fully public implementation
  details, or documented only indirectly through the top-level install command?
- Do we want npm global install as the primary documented npm path, or also
  support `npx kato@latest ...` in Phase 1?
- How much npm-package payload duplication is acceptable when each platform
  package includes three binaries plus metadata?
- Do we need a Linux musl package for the first public npm cut, or is explicit
  `linux-x64-gnu` support enough?
- Which publish mechanism should own registry auth in CI:
  token-based publish or trusted publishing?

## Decisions

- npm is the intended primary user-facing distribution channel.
- npm packaging should reuse the native binary outputs; it should not compile
  or download runtime artifacts during install.
- The preferred npm architecture is:
  - one top-level wrapper package
  - one platform package per supported target
- The public wrapper package name is `kato`.
- The default platform package prefix is `@spectacular-voyage/kato`.
- Platform packages should include `kato`, `kato-daemon`, and `kato-web`.
- The public npm entrypoint remains `kato`; `kato-daemon` and `kato-web` remain
  implementation details of the installed bundle.
- The npm channel keeps the same runtime/config filesystem contract as direct
  binary installs.
- Unsupported platforms should fail with an explicit runtime error, not an
  implicit broken install.

## Contract Changes

- Add a documented npm install path, expected to look like:
  - `npm install -g kato`
- Add a documented npm upgrade path, expected to look like:
  - `npm update -g kato`
- Add a documented npm uninstall path, expected to look like:
  - `npm uninstall -g kato`
- Clarify in user docs that npm uninstall removes the installed program but
  does not automatically delete Kato-owned data under `~/.kato`.
- Add a Node-based wrapper entrypoint that must preserve:
  - exit code
  - stdio behavior
  - argv forwarding
  - signal propagation

## Testing

- Add unit tests for the wrapper's platform-package resolution and
  unsupported-platform error path.
- Current local assembly test result:
  - `deno test --allow-read --allow-write=.test-tmp tests/npm-package-assembly_test.ts`
- Current local npm smoke result:
  - `deno run --frozen -A scripts/smoke-npm-install.ts --input-dir .test-tmp/npm-packages/package-smoke --npm-bin <npm-path>`
  - passed for:
    - wrapper package `kato`
    - platform package `@spectacular-voyage/kato-linux-x64-gnu`
    - `kato --version`
    - `kato init`
    - `kato web init`
    - `kato web start`
    - `/login`
    - `kato web status`
    - `kato web stop`
- Add local smoke coverage using `npm pack` for:
  - wrapper package
  - one platform package
- Add install smoke checks in temp directories for:
  - `npm install -g <local-tarball>`
  - `kato --version`
  - `kato web start` package-resolution path
- Add release-pipeline smoke checks proving the top-level wrapper actually
  launches the packaged native `kato` binary rather than falling back to source
  or Deno.
- Add publish-assembly checks proving the npm platform package contents match
  the packaged native bundle contents for the same version.
- Add install/update/uninstall doc verification for the npm channel once the
  README wording exists.

## Non-Goals

- Requiring Deno for the npm install path.
- Compiling Kato on the user machine during npm install.
- Downloading GitHub release assets in `postinstall`.
- Publishing Kato as a reusable JS library.
- Reimplementing Kato runtime behavior in Node.
- Supporting every npm-capable platform in the first cut.

## Implementation Plan

- [x] Confirm the publish names for the top-level package and all platform
      packages:
      `kato` plus scoped platform packages under
      `@spectacular-voyage/kato-*`.
- [x] Add a script that assembles npm package directories from the existing
      packaged binary outputs.
- [x] Add the generated top-level wrapper package with:
      `package.json`, `bin`, `optionalDependencies`, and Node launcher script.
- [x] Add generated platform package templates with `os`, `cpu`, and where
      needed `libc` metadata.
- [x] Make each platform package include `kato`, `kato-daemon`, `kato-web`, and
      release metadata.
- [x] Add local `npm pack` and temp-install smoke checks for at least one
      supported platform package plus the wrapper package.
- [x] Extend the release workflow so npm package assembly happens after native
      bundle packaging.
- [ ] Add npm publish automation only after local package assembly and install
      smoke checks are stable.
- [ ] Update README/install docs and [[dev.release-runbook]] once the npm
      package shape is proven.
