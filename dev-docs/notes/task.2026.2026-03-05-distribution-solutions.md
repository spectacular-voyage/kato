---
id: wvgli7yr4zmuwcalv6wyevu
title: 2026 03 05 Distribution Solutions
desc: ''
updated: 1772763714804
created: 1772761416593
---

## Goal

Define a post-`v0.2.0` distribution plan that makes `kato` easy to install for
non-programmers, does not require Deno for the primary install path, supports
user-approved updating, has a sane uninstall story, and leaves room for later
user-level service-manager integration.

## Current Constraints From The Codebase

- The codebase already has separate CLI and daemon apps:
  `apps/cli` and `apps/daemon`.
- Shared runtime state already has a stable per-user layout under `~/.kato`,
  with shared coordination files under `~/.kato/shared` and daemon config under
  `~/.kato/daemon`.
- `KATO_RUNTIME_DIR` chooses the daemon runtime root; status and control paths
  are derived from that root and live under the same `~/.kato/shared` tree.
- Today the CLI launcher is source-oriented: it starts the daemon by running
  Deno against `apps/daemon/src/main.ts`.
- Current least-privilege behavior partly depends on Deno subprocess permission
  scoping (`--allow-read=...`, `--allow-write=...`). A compiled/binary path
  must either preserve that boundary another way or accept that some of that
  protection becomes app-level rather than runtime-enforced.

## Distribution Goals

- One-command or installer-based setup for non-programmers.
- No Deno prerequisite for the primary install path.
- Auto-update support with an explicit user permission gate.
- A clear answer to "which daemon is this CLI talking to?"
- Stable per-user config/state locations across all install channels.
- A path to later `systemd --user`, `launchd`, or Windows integration.
- Straightforward uninstall that does not accidentally destroy user data.
- One release pipeline that can publish GitHub artifacts, npm packages, and JSR
  from the same versioned release event.

## Recommendation

### Primary Channel: Native Binary Releases

- Ship prebuilt native binaries from GitHub Releases.
- Treat those binaries as the primary user-facing install path.
- Use one platform bundle per target platform/architecture.
- Bundle both `kato` and `kato-daemon` in the same install/update unit.

This is the best fit for the stated goal because it removes both the source
checkout requirement and the Deno prerequisite.

### Bundle Two Executables, Not One

Recommendation: keep two executables in the shipped bundle:

- `kato`
- `kato-daemon`

Why this is better than a single self-reexecing binary:

- It matches the current architectural split.
- It makes daemon startup and service-manager wiring explicit.
- It avoids forcing the CLI to rediscover source files.
- It leaves room for different runtime behavior, packaging, or permissions
  later.
- It makes direct daemon launching from a service manager cleaner.

### Rejected For Now: Single Binary With Hidden Daemon Mode

A single binary with a hidden `daemon run` mode is technically possible and
would simplify daemon discovery, but it should not be the main plan right now.

Tradeoffs:

- It increases coupling between the CLI and daemon packaging story.
- It makes service-manager docs less explicit.
- It further blurs permission boundaries if compiled distribution already has to
  relax current Deno subprocess scoping.

## How The CLI Knows Which Daemon To Use

There are really two separate questions:

1. Which daemon executable should `kato start` launch?
2. Which daemon instance is the CLI talking to after startup?

Recommended answer:

- Executable discovery:
  - default to a sibling executable next to `kato`
  - allow override via env var, for example `KATO_DAEMON_BIN`
  - optionally persist the resolved daemon path in CLI config later if needed
- Instance discovery:
  - continue using the runtime root and shared control/status files
  - the CLI talks to the daemon instance associated with the current
    `KATO_RUNTIME_DIR` or default `~/.kato/daemon`

Important point: "which daemon" should mostly mean "which runtime root /
control+status files", not "which process binary name". The shared files under
`~/.kato/shared` are already the instance identity.

## Where Service-Managed Daemons Should Store Their Files

Recommendation:

- Keep all Kato-owned state in `~/.kato/...`, even when the daemon is started by
  an OS service manager.
- Do not move Kato runtime data into service-manager-specific directories.
- Service-manager config should only store:
  - executable path
  - optional `KATO_RUNTIME_DIR`
  - restart policy
  - user/account context

This keeps all install channels and launch modes aligned with the current
filesystem contract.

## Service-Manager Direction

This should remain post-MVP, but the direction should be clear now:

- Prefer per-user services, not system-wide privileged services.
- Linux: prefer `systemd --user`.
- macOS: prefer `launchd` LaunchAgents.
- Windows: prefer a per-user startup mechanism first, not a classic machine-wide
  Windows Service.

Why per-user matters:

- provider session roots live in the user's home directory
- `~/.kato` is per-user
- running as `root`, `LocalSystem`, or another service account creates access
  and path-resolution problems immediately

### Service Identity Naming

Recommendation:

- `systemd --user`: use a fixed unit name like `kato-daemon.service`
- `launchd`: use a fixed per-user label like
  `com.spectacularvoyage.kato.daemon`
- Windows per-user startup entry: display name may include the username for
  clarity, but the durable identity should use a stable user-specific key

Reasoning:

- `systemd --user` and `launchd` are already per-user namespaces, so the unit
  does not need the username in its actual identifier.
- On Windows, if a machine-global service identity is ever introduced later, it
  should derive from the user's SID or another stable internal identifier, not
  the raw username. This is an engineering recommendation.

## Windows Installer Strategy

### Do We Want A Windows Installer?

Yes, but not as the only Windows artifact.

Recommended Windows outputs:

- portable `.zip` bundle for advanced users and direct download
- per-user installer for non-programmers

The installer should be the default documented Windows path once binary
shipping exists.

### Installer Type

Recommendation: prefer a signed per-user MSI first, or a signed EXE installer if
MSI tooling friction is materially lower.

Why this direction:

- Windows users expect install/uninstall via Apps & Features.
- Per-user installs show up in Add/Remove Programs for the current user.
- WinGet supports MSI, EXE, ZIP, and other installer types, so MSI or EXE both
  fit a later WinGet channel.

Inference:

- MSI is slightly preferable for standard uninstall/repair semantics and
  enterprise behavior.
- MSIX is not the first recommendation for Kato's direct-download path because
  it adds packaging/signing/store-style complexity that is not needed for the
  initial goal.

### What The Windows Installer Should Do

- install `kato` and `kato-daemon`
- add the CLI to PATH for the current user
- register uninstall information for Apps & Features
- optionally install a per-user auto-start integration later
- not auto-start background capture without clear user consent
- not delete `~/.kato` data on uninstall by default


## Script-Based Direct Installers

The PowerShell and shell-script installer pattern is not overkill for an early
binary distribution phase. It is a good phase-1 channel.

Recommended use:

- macOS/Linux: `curl -fsSL <url> | sh`
- Windows PowerShell: `irm <url> | iex`

What these scripts should do:

- detect OS and architecture
- resolve the latest or requested version
- download the correct release asset from GitHub Releases
- verify checksum before install
- install into a user-local program directory, not into `~/.kato` runtime data
- add or suggest PATH updates for the user-local bin directory
- write install-channel metadata so `kato` knows it was script-installed
- support `--version <x.y.z>` for pinned installs

Recommended install locations:

- macOS/Linux: `~/.local/bin` or a dedicated user-local Kato program dir
- Windows: `%LOCALAPPDATA%\\Programs\\Kato\\bin`

Important separation:

- program files should not live inside `~/.kato`
- `~/.kato` should remain runtime/config/data state

These scripts do not need to be generated every release. They can be stable,
source-controlled installer entrypoints that fetch stable latest-release asset
names.
## npm Distribution Options

Lots of target users already have npm. That makes npm a strong convenience
channel, but not the primary runtime model.

### Recommended npm Model

- Publish a small `kato` npm wrapper package.
- Give it a `bin` entry that launches the packaged native `kato` executable.
- Publish platform-specific binary packages selected via npm metadata:
  `optionalDependencies`, `os`, `cpu`, and `libc`.
- Put both `kato` and `kato-daemon` binaries inside each platform package.

This is better than "npm installs source and requires Deno" because the goal is
easy installation for non-programmers.

### What npm Should Not Be

- Not the source of truth for compiled-on-user-machine installs.
- Not a postinstall compile step.
- Not a wrapper that still requires Deno.

### Why Avoid Postinstall Downloads If Possible

Using npm only as a thin JS wrapper around already-packaged platform binaries is
cleaner than downloading executables in `postinstall`.

Reasons:

- more deterministic installs
- better behavior with lockfiles and mirrors
- fewer corporate proxy surprises
- fewer security surprises for users
- easier offline/cached installs

If a postinstall download fallback is ever added, it should be a fallback, not
the primary design.


### What The npm Wrapper Should Actually Look Like

The npm wrapper should not execute the shell/PowerShell install scripts.

That would be the wrong ownership model because:

- npm would not really own the installed files anymore
- uninstall would become confusing
- cross-platform shelling-out during npm install is fragile and surprising

Recommended npm structure:

- top-level package: `kato`
- platform packages, for example:
  - `@spectacular-voyage/kato-win32-x64`
  - `@spectacular-voyage/kato-darwin-arm64`
  - `@spectacular-voyage/kato-darwin-x64`
  - `@spectacular-voyage/kato-linux-x64-gnu`
- top-level `kato` package declares:
  - `bin`
  - `optionalDependencies` on the platform packages
- each platform package declares matching `os`, `cpu`, and where relevant
  `libc`
- each platform package contains both `kato` and `kato-daemon`
- the top-level `bin` entry points to a tiny Node launcher script that resolves
  the installed platform package and `spawn()`s the packaged `kato` binary with
  the current argv/stdio

Why a tiny Node launcher is fine:

- npm already assumes Node is present
- npm can manage install/uninstall cleanly
- the actual Kato runtime remains native binaries, not Node business logic

Uninstall behavior stays clean:

- `npm uninstall -g kato` removes npm-managed shims and packages
- npm does not need to understand or run shell installer scripts
## JSR Distribution Options

JSR is still worth doing, but as a Deno-first channel, not the primary
non-programmer install path.

Recommended role for JSR:

- publish the CLI entrypoint as a JSR package
- support Deno users and CI/power-user installs
- keep it as the source/distribution channel for Deno-native consumers

Good fit:

- Deno users
- CI
- contributors
- power users who prefer `deno install`

Poor fit for the primary goal:

- it still assumes a Deno runtime
- it does not remove the "install Deno first" friction for non-programmers


## Permission Model After Compile

`deno compile` changes the security story materially because permission flags are
baked in at compile time instead of being narrowed on each daemon launch.

Implications:

- a compiled binary cannot keep today`s dynamic `deno run --allow-read=...`
  and `--allow-write=...` narrowing model
- if Kato allows user-requested output paths anywhere on disk, the compiled
  binary likely needs broad write permission
- if provider session roots remain configurable, the compiled daemon may also
  need broad read permission, or at least a wider read scope than today

### Recommended Compiled Permission Split

Recommendation:

- `kato-daemon`:
  - broad read permission
  - broad write permission
  - env permission as needed
  - no network permission
- `kato` CLI:
  - local filesystem permissions needed for config/control/status operations
  - env permission as needed
  - network permission only if `self-update` and release-check features are
    implemented inside the CLI

This keeps the long-running daemon network-dark while still allowing an explicit,
user-consented updater path in the CLI.

### What Happens To `allowedWriteRoots`

`allowedWriteRoots` does not go away.

Instead, its role becomes more important:

- in source/Deno mode: `allowedWriteRoots` is product policy plus defense in
  depth behind Deno`s runtime sandbox
- in compiled mode: `allowedWriteRoots` becomes the primary app-level write
  authorization boundary for user-requested output paths

That means compiled distribution does require hardening current
`allowedWriteRoots` usage.

### What Needs To Be True In Compiled Mode

- every user-controlled write path must pass through `WritePathPolicyGate`
- `record`, `capture`, and `export` paths must all be covered
- Kato-owned internal writes under its own runtime/program directories should be
  treated separately from user-requested output writes
- provider discovery and ingestion should continue to respect
  `providerSessionRoots`, but that becomes primarily app-level policy rather
  than Deno-enforced launch scoping

### Practical Consequence

The compiled build likely needs broader baked-in filesystem permissions than the
source-launched daemon, but that is acceptable if:

- `allowedWriteRoots` remains mandatory and well-tested
- `providerSessionRoots` remains mandatory and well-tested
- network stays denied for the daemon
- compiled-binary smoke tests explicitly cover out-of-root write denial
## Auto-Update Strategy

Support auto-updating, but make it explicit, permission-gated, and
channel-aware.

### Recommended Update Model

- Add a `kato self-update` command.
- Add an opt-in update check mode later.
- Always require explicit user confirmation before applying an update.
- Download a platform-specific signed manifest and release artifact.
- Verify checksum/signature before replacement.
- Stop the daemon before replacing binaries.
- Replace both `kato` and `kato-daemon` together.
- Restart the daemon only if it was running before the update.
- Keep the previous version around briefly for rollback.

### Important: Updates Must Be Channel-Aware

Do not let every channel mutate itself the same way.

Recommended behavior:

- direct portable binary install:
  - `kato self-update` may replace files in place
- installer-managed install:
  - `kato self-update` should download and launch the next installer only after
    consent, or delegate to `winget upgrade` / installer-managed upgrade flow
- npm install:
  - prefer `npm install -g kato@latest` / `npm update -g kato`
  - `kato self-update` should either defer to npm or clearly refuse
- JSR / Deno install:
  - prefer the Deno-native reinstall/upgrade path
  - `kato self-update` should not overwrite a Deno-managed install silently

Without channel awareness, the updater will eventually fight npm, MSI, or Deno
and leave users in a confusing state.

### Update Consent UX

Good default behavior:

- no silent background mutation
- notify-only checks unless the user opts in
- explicit confirmation before download/apply
- clear release version and channel shown before update

## Uninstall Model

### Principle

Separate these concerns:

- removing the installed program bits
- removing Kato-managed runtime data
- removing Kato-managed service/autostart registrations

Trying to make one command magically own every installation channel is likely to
create more confusion than value.

### Default Uninstall Policy

Recommendation:

- uninstall removes executables, PATH entries, wrappers, and service/autostart
  registration owned by that channel
- uninstall does not delete `~/.kato` by default
- uninstall may offer an explicit "remove my Kato data too" option, but it
  should be opt-in and clearly named

Why preserve `~/.kato` by default:

- it likely contains captured conversations and user configuration
- accidental deletion is much worse than leaving recoverable data behind
- reinstall/repair flows become safer

### Channel-Specific Uninstall Behavior

- portable binary bundle:
  - remove install directory or run a helper uninstall script
  - stop daemon first
  - remove user-level auto-start integration if present
- Windows installer:
  - uninstall from Apps & Features, `winget uninstall`, or installer repair UI
  - remove installed executables and registered auto-start/service entries
  - leave `~/.kato` unless the user explicitly chooses purge
- npm:
  - `npm uninstall -g kato`
  - should remove npm-managed shims and package files
  - should not purge `~/.kato`
- JSR / Deno:
  - use the Deno uninstall/remove path for the installed executable
  - should not purge `~/.kato`

### Kato-Owned Cleanup Commands

Recommendation:

- prefer explicit cleanup commands for Kato-owned state, for example:
  - `kato service uninstall`
  - `kato data purge`
- do not rely on every external package manager to understand Kato's service and
  data semantics

## Release Automation Strategy

### One Release Workflow Is Reasonable

Yes: one GitHub Actions release workflow should be able to build and distribute
all artifacts, but it should do so as an orchestrated pipeline, not as one
blind publish step.

Recommended trigger:

- annotated version tag like `vX.Y.Z`
- optionally `workflow_dispatch` for dry runs or release-candidate testing

### Recommended Release Flow

1. Validate version alignment.
2. Run CI/tests.
3. Build compiled binaries for all target platforms.
4. Package platform archives and Windows installer artifacts.
5. Generate checksums and update manifest.
6. Create a draft GitHub release and upload all release assets.
7. Publish npm packages.
8. Publish JSR package.
9. Publish or undraft the GitHub release only after registry publishing passes.

Why draft first:

- npm and JSR package versions are immutable once published.
- A draft GitHub release gives room to retry packaging/publishing failures
  without showing a broken public release page immediately.

### Publish Failure / Retry Model

The workflow needs to be idempotent enough that reruns do not force a version
bump after partial success.

Recommended approach:

- GitHub release creation should tolerate rerun/update behavior while still in
  draft.
- JSR publishing is already naturally skip-safe when the version exists.
- npm publishing should check whether each target package version already exists
  before attempting publish, and skip if present.

### Version Source Of Truth

Recommendation:

- use the Git tag release version as the single user-facing release version
- stamp npm package versions, JSR package version, binary metadata, and release
  artifact names from that one version source

Current CLI/daemon version split is acceptable internally, but release
orchestration should avoid making users reason about three unrelated version
numbers.

## Stable Latest Download URLs

GitHub already supports "latest release" links, including direct latest asset
links.

Recommended asset naming strategy:

- upload versioned assets for traceability, for example
  `kato-v0.3.0-windows-x64.zip`
- also upload stable-name assets for the latest-download URL pattern, for
  example:
  - `kato-windows-x64.zip`
  - `kato-macos-arm64.tar.gz`
  - `kato-linux-x64.tar.gz`
  - `kato-update-manifest.json`

This enables stable URLs such as:

- `/releases/latest`
- `/releases/latest/download/kato-windows-x64.zip`
- `/releases/latest/download/kato-update-manifest.json`

The manifest asset is especially useful for the updater because it can include:

- current version
- per-platform asset names and URLs
- checksums
- minimum supported upgrade version if migrations are needed

## Performance Considerations

- Precompiled binaries remove the Deno installation and source-checkout startup
  path.
- Keep the daemon long-running and lightweight to start from the CLI.
- Build binaries in CI, not on user machines.
- Do not use self-extracting binaries unless a real "files must exist on disk"
  requirement appears.
- Audit dynamic imports, workers, and extra assets so compiled binaries include
  only what they need.
- Keep the bundle per-platform and per-arch; do not ship giant multi-platform
  payloads to every user.
- Sign/notarize binaries to reduce OS trust friction and first-run penalties.

### Important Performance/Security Tradeoff

Compiled binaries are good for user experience, but they weaken one part of the
current design: today the daemon is launched under Deno with runtime-scoped
file permissions.

That means the binary path should also include:

- stronger app-level path guard coverage
- explicit compiled-binary smoke tests
- tests proving provider reads/writes still stay within configured roots

## Linux Target Caveat

The current official Deno compile target list shows GNU Linux targets, not musl
targets. That means Alpine-style support is not something to assume.

Implication:

- target Linux glibc first
- treat musl/Alpine support as a separate decision and test track

This is an inference from the currently documented supported targets.

## What Else You May Be Missing

- rollback behavior when an update fails halfway through
- config/schema migration handling across releases
- uninstall UX wording and purge confirmation design
- PATH setup on each install channel
- multi-install ambiguity if a user has release, installer, npm, and source
  installs
- release channels (`stable`, maybe `beta`)
- checksums, signatures, and tamper resistance
- corporate proxies and blocked GitHub downloads
- code signing and notarization
- ARM target priorities
- CLI/daemon version-skew policy during upgrades
- migration policy when runtime file layout changes again
- whether WinGet should become an additional Windows channel after the installer
  exists

## Proposed Phased Plan

### Phase 1

- Add release workflow for prebuilt platform binaries.
- Ship direct binary bundles as the primary install path.
- Change launcher logic to resolve a sibling `kato-daemon` binary, with
  source-tree fallback for development.
- Define uninstall defaults: preserve `~/.kato`, remove program bits only.
- Keep updates manual for the first binary release.

### Phase 2

- Publish npm wrapper plus platform binary packages.
- Publish JSR package for Deno-native users.
- Introduce install-channel metadata so the app knows whether it was installed
  from direct binary, installer, npm, or Deno/JSR.
- Add stable latest-download assets and update manifest.
- Add `kato self-update --check` and `kato self-update --apply` with
  channel-aware behavior.

### Phase 3

- Add per-user service-manager helpers/installers.
- Add Windows per-user installer.
- Add rollback support and signed update manifests.
- Add compiled-binary smoke coverage and migration tests.
- Revisit whether direct binary installs should become the default documented
  path in README and release notes.

## Concrete Follow-Up Tasks

- Add a daemon executable resolution abstraction with precedence:
  - explicit CLI config override
  - env override (`KATO_DAEMON_BIN`)
  - sibling installed binary
  - source-tree fallback for developers
- Add GitHub release workflow(s) that build:
  - Windows x64
  - macOS arm64
  - macOS x64
  - Linux x64
- Decide whether Linux arm64 is in the first binary wave or second.
- Add release asset naming rules for:
  - versioned artifacts
  - stable latest-download artifacts
  - checksums
  - update manifest
- Add install docs for:
  - direct binary release
  - Windows installer
  - npm
  - JSR / Deno
- Add install-channel metadata so update and uninstall behavior can be
  channel-aware.
- Add explicit service/autostart cleanup commands.
- Add checksum/signature verification design for updater work.
- Add compiled-binary smoke tests.
- Revisit version policy so release artifacts have one clear user-facing version
  even if CLI and daemon keep separate internal versions.

## External Reference Notes

- GitHub supports latest-release links and direct latest asset download URLs.
- GitHub CLI can create a release and upload assets in one command flow.
- npm supports `bin`, `optionalDependencies`, `os`, `cpu`, and `libc`, which
  are useful for platform-specific wrapper packages.
- npm trusted publishing currently supports GitHub-hosted GitHub Actions
  runners.
- JSR supports tokenless publishing from GitHub Actions when the package is
  linked to the repository and the workflow has `id-token: write`.
- WinGet supports MSI, EXE, ZIP, and other installer types.
- Windows Installer surfaces per-user installs in Add/Remove Programs for the
  current user.

