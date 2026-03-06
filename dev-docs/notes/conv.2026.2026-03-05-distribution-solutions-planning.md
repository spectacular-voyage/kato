---
id: distribution-solutions-1198662a
title: 'Distribution Solutions'
desc: ''
created: 1772761464515
updated: 1772768639480
kato-sessionIds: [019cc0ce-265f-7ba3-8cc4-b1f70c944c9b]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [1198662a-0e8f-4869-aeeb-d972799cff95]
conversationEventKinds: [message.user, message.assistant, tool.call, tool.result]
participants: [codex.gpt-5.4]
---

# User_2026-03-05_1744_24

Distribution Solutions

Review [task.2026.2026-02-22-ci-cd.md](dev-docs/notes/task.2026.2026-02-22-ci-cd.md) for background, and @dev.todo has a bit of relevance. 

As a non-programmer user, I want to be able to easily install kato.

Deno support binaries, that's one route. But I guess we need separate binaries for "kato" the cli, and some currently-undefined "kato-daemon"? Or maybe they'd be the same binary, just used differently.

[dev.decision-log.md](dev-docs/notes/dev.decision-log.md) mentions Defer OS service-manager integration to post-MVP (`systemd`,
  launchd, Windows Service), but that'd be nice too, so people don't always have to manuall start the daemon.

One issue is: how does the CLI know which daemon to use? Where to the OS service-manager versions store their files. 

Lots of my target customers might have npm installed, but not Deno. What are our options for distributing via npm?

jsr.io is probably an easy and good distribution option.

How can we optimize our distributions for performance?

What other considerations am I missing?

::capture-k C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\conv.2026.2026-03-05-distribution-solutions-planning.md

# gpt-5.4_2026-03-05_1744_34

Reviewing the CI/CD notes, decision log, and any `@dev.todo` references first so I can turn this into a concrete distribution recommendation rather than a generic packaging list.

# gpt-5.4_2026-03-05_1744_47

The repo already answers a few of the hard questions: runtime files are centered on `~/.kato/{daemon,shared}`, and the codebase is already split into separate CLI and daemon apps. I’m pulling those specifics now so the recommendation lines up with the current architecture instead of fighting it.

# gpt-5.4_2026-03-05_1744_58

The docs confirm the current contract: one detached daemon process, one CLI, and a stable shared state directory under `~/.kato/shared`. I’m checking the launch path next because that determines whether we should ship one binary with subcommands or two distinct binaries.

# gpt-5.4_2026-03-05_1745_14

The launcher is still Deno-source-oriented today: the CLI shells out to `deno run ... apps/daemon/src/main.ts __daemon-run`. That strongly favors either a wrapper package or a deliberate compile step, not just “publish the current repo to npm and call it done.”

# gpt-5.4_2026-03-05_1746_09

I have the core constraint now: a compiled CLI won’t be enough by itself, because the current launcher resolves `apps/daemon/src/main.ts` from the source tree and starts it with `deno run`. I’m pulling exact line references and then I’ll write the distribution recommendation into the planning note.

# gpt-5.4_2026-03-05_1747_26

I’m about to update the planning note with a concrete recommendation: ship binaries as the primary install path, treat npm as a wrapper channel, and keep JSR as a Deno/source channel. Checking the worktree first so I don’t step on unrelated edits.

# gpt-5.4_2026-03-05_1747_31

I hit a dirty worktree with changes I didn’t make, including docs files near the area you pointed at:

- `dev-docs/notes/dev.todo.md` modified
- several `task.*` notes deleted/re-added as `completed.*`
- `shared/src/contracts/config.ts` modified
- `dev-docs/notes/conv.2026.2026-03-05-distribution-solutions-planning.md` is currently untracked

How do you want me to proceed: keep going read-only and answer here, or go ahead and write/update the distribution planning note despite the existing changes?

# gpt-5.4_2026-03-05_1747_38

I hit a dirty worktree with changes I didn’t make, including docs files near the area you pointed at:

- `dev-docs/notes/dev.todo.md` modified
- several `task.*` notes deleted/re-added as `completed.*`
- `shared/src/contracts/config.ts` modified
- `dev-docs/notes/conv.2026.2026-03-05-distribution-solutions-planning.md` is currently untracked

How do you want me to proceed: keep going read-only and answer here, or go ahead and write/update the distribution planning note despite the existing changes?

# User_2026-03-05_1751_08

Oh, forgot to mention: I want to be able to support auto-updating (with a user's permission gate), so people don't have to reinstall. You can update the [task.2026.2026-03-05-distribution-solutions.md](dev-docs/notes/task.2026.2026-03-05-distribution-solutions.md) , don't worry about those other changes.

# gpt-5.4_2026-03-05_1751_19

Proceeding with the task note update only. I’m pulling the current file plus a few official docs so the recommendations cover npm, JSR, binaries, and the new auto-update requirement with concrete tradeoffs.

# gpt-5.4_2026-03-05_1754_09

I’ve got the recommendation structure. Writing it into the task note now, with explicit guidance on binary packaging, npm/JSR roles, daemon discovery, service-manager shape, and channel-aware auto-updates.

# gpt-5.4_2026-03-05_1757_19

The note is written. I’m doing one quick pass to clean structure and update the frontmatter timestamp so it reflects the edit instead of looking stale in the notes index.

# gpt-5.4_2026-03-05_1758_32

Updated [task.2026.2026-03-05-distribution-solutions.md](C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\task.2026.2026-03-05-distribution-solutions.md).

Core recommendation:
- Primary install path: prebuilt native binaries from GitHub Releases.
- Ship `kato` and `kato-daemon` as two executables in one bundle, not one combined binary.
- CLI should find the daemon by sibling executable path by default, with an override like `KATO_DAEMON_BIN`.
- Daemon instance identity should stay tied to the runtime root and shared files under `~/.kato`, not to a special binary name.
- npm should be a convenience channel that installs packaged native binaries, not a Deno-dependent wrapper.
- JSR should be a secondary Deno-native channel, not the primary non-programmer install path.
- Auto-update should be explicit and channel-aware: direct binary installs can use `kato self-update`; npm and JSR installs should update through npm/Deno instead.
- Service-manager support should be per-user, not system-wide, because provider session roots and `~/.kato` are user-home based.
- Biggest extra concerns are signing/notarization, rollback, config migration, Linux glibc vs musl, and the security tradeoff from losing current `deno run --allow-*` subprocess scoping in compiled builds.

I did not run tests because this was a docs-only change.

Official references used:
- [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/)
- [Deno install](https://docs.deno.com/runtime/reference/cli/install/)
- [npm `package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- [JSR publishing docs](https://jsr.io/docs/publishing-packages)

Natural next steps:
1. I can turn Phase 1 into a concrete implementation checklist and release workflow task list.
2. I can prototype the launcher change to resolve a sibling `kato-daemon` binary with source fallback.
3. I can draft the npm package layout for the wrapper plus platform-specific binary packages.

# User_2026-03-05_1804_21

Let's flesh out uninstall. Do we want a Windows installer? Ideally we have a github "release" action that generates all the artifacts and distributes them to npm, jsr, and default "download" URLs that always download the latest version. I guess for OS-native service managers, if the daemon is per-user, the service should be allowed to install per user with a service name that reflects the user.

# gpt-5.4_2026-03-05_1804_34

Expanding the task note around uninstall, Windows installer shape, release automation, and per-user service identity. I’m checking the current note plus current official package/release docs so the recommendations line up with how npm and JSR actually publish today.

# gpt-5.4_2026-03-05_1804_51

I’m tightening this around operational details now: uninstall semantics, whether Windows should get a real installer or just a packaged binary first, and how a single release pipeline can fan out to GitHub Releases, npm, JSR, and stable “latest” download links.

# gpt-5.4_2026-03-05_1807_14

I have the main shape now. The two non-obvious design points are: uninstall should be split between “remove the program” and “remove Kato-owned user data,” and Windows should probably use a per-user installer plus a portable zip, not a Windows Service first. I’m folding that into the task note along with a release workflow that publishes GitHub assets, npm, and JSR from one run without creating version-skew confusion.

# gpt-5.4_2026-03-05_1809_09

The task note now covers uninstall ownership, a Windows installer recommendation, the release pipeline shape, and how stable latest-download URLs should work. I’m doing a final read-through so the new guidance is internally consistent with the earlier channel-aware update model.

# gpt-5.4_2026-03-05_1809_40

Expanded [task.2026.2026-03-05-distribution-solutions.md](C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\task.2026.2026-03-05-distribution-solutions.md).

Key decisions now captured there:
- Uninstall should preserve `~/.kato` by default.
- Program removal, data purge, and service/autostart cleanup should be treated as separate operations.
- Windows should eventually have both a portable `.zip` and a per-user installer.
- The Windows installer should likely be a signed per-user MSI first, or signed EXE if MSI tooling is lower-friction.
- A single GitHub Actions release workflow should orchestrate everything: build binaries, create a draft GitHub release, upload assets, publish npm, publish JSR, then undraft/publish the release.
- Stable “latest” download URLs should come from GitHub latest-release asset links, with fixed asset names like `kato-windows-x64.zip` and `kato-update-manifest.json`.
- Per-user service identity should be fixed-name on `systemd --user` and `launchd`; Windows should avoid a classic machine-wide service first and use a per-user startup mechanism.

Direct answers:
- Windows installer: yes, but not as the only Windows artifact.
- Uninstall: remove app bits by channel, keep `~/.kato` unless the user explicitly opts into purge.
- One release action: yes, but make it staged and idempotent; draft-first avoids exposing a half-published release.
- “Latest” download URLs: yes, use stable asset names on the latest release plus an update manifest.
- Per-user service name: fixed per-user unit names are fine on Linux/macOS; on Windows, if a machine-global service ever exists later, use a stable user-specific key or SID-derived identity, not the raw username.

Notes:
- I did not run tests; this was a docs-only change.
- That task file is currently still untracked in git, same as before.

Official references used:
- [GitHub release links and latest release](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
- [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create)
- [npm `package.json` fields](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- [npm trusted publishing with GitHub Actions](https://docs.npmjs.com/trusted-publishers)
- [JSR publishing from GitHub Actions](https://jsr.io/docs/publishing-packages#publishing-from-github-actions)
- [WinGet supported installer types](https://learn.microsoft.com/windows/package-manager/package/manifest#installers)
- [Windows Installer per-user Add/Remove Programs behavior](https://learn.microsoft.com/windows/win32/msi/adding-and-removing-an-application-and-leaving-no-trace-in-the-registry-for-non-managed-applications)

Natural next steps:
1. I can turn the release workflow section into a concrete `.github/workflows/release.yml` plan.
2. I can draft the npm package layout and naming for wrapper plus platform packages.
3. I can sketch the installer/update/uninstall command surface so the channel-aware behavior is explicit.

# User_2026-03-05_1809_41

What's the story with losing deno run --allow-* scoping? Does that mean we have to address the current usage of allowedWriteRoots?

# gpt-5.4_2026-03-05_1809_54

Checking the exact places where `allowedWriteRoots` is enforced today so I can answer whether compiled binaries break that model or just remove one layer of protection.

# gpt-5.4_2026-03-05_1810_44

I’ve got the answer: `allowedWriteRoots` does not go away, but in a compiled build it stops being reinforced by Deno’s launch-time sandbox and becomes the primary app-level policy. Pulling exact line numbers so I can point at the current defense-in-depth layers clearly.

# gpt-5.4_2026-03-05_1811_48

Yes, partially.

**Short Answer**

- Today `allowedWriteRoots` is protected twice.
- In a compiled binary, you likely lose the dynamic `deno run --allow-write=<roots>` layer.
- That does **not** make `allowedWriteRoots` obsolete.
- It means `allowedWriteRoots` becomes the **primary app-level write authorization boundary** instead of a second layer behind Deno’s sandbox.

**Current Model**

There are two separate protections today:

- Launch-time Deno sandbox:
  - the launcher builds `--allow-read=...` and `--allow-write=...` from runtime paths, `allowedWriteRoots`, and `providerSessionRoots` in [launcher.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/orchestrator/launcher.ts:112)
- In-app path policy:
  - `WritePathPolicyGate` canonicalizes the target path and denies anything outside configured roots in [path_policy.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/policy/path_policy.ts:96)
  - the daemon wires that gate into the recording pipeline in [main.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/main.ts:390)

Also, `workspace register` currently mutates shared `allowedWriteRoots` and warns that a running daemon may still deny writes until restart in [workspace_register.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/cli/src/commands/workspace_register.ts:39) and [workspace_register.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/cli/src/commands/workspace_register.ts:215).

**What Changes With `deno compile`**

Official Deno docs say compile-time runtime flags, including permission flags, are applied to the resulting binary: [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/).

That means:
- you can’t keep today’s per-launch dynamic `--allow-write=<whatever is in shared config right now>` model in the same way
- a generic shipped binary will probably need broader compiled-in file permissions than today’s source-launched daemon

Also, runtime permission prompts are not viable for a detached daemon because Deno does not show prompts when stdout/stderr are not a TTY: [Deno security/permissions](https://docs.deno.com/runtime/fundamentals/security/).

**So Do We Have To Address `allowedWriteRoots`?**

Yes, but the answer is “harden it”, not “replace it”.

What needs to change conceptually:
- `allowedWriteRoots` should be treated as the **authoritative product policy** for user-requested output paths
- Deno permission narrowing becomes optional defense-in-depth when running from source
- compiled builds must assume the app gate is the main protection

What does **not** need to change:
- the user-facing concept of `allowedWriteRoots`
- the fact that workspace registration can auto-add workspace roots
- the restart-bound semantics, unless you choose to add live config reload

**Practical Implication**

For compiled binaries, you should verify that every user-controlled write path goes through `WritePathPolicyGate` before any file operation.

That means auditing:
- `record`
- `capture`
- `export`
- any future installer/update/service-generated writes outside Kato-owned directories

You do **not** want to force internal Kato runtime files under `~/.kato` through `allowedWriteRoots`; those are app-owned writes, not user-requested output writes.

**Parallel Read-Scope Issue**

This same issue exists for `providerSessionRoots` on the read side:
- today they help shape `--allow-read=...` in the launcher
- in compiled builds, they become primarily app-level discovery/policy unless you add some other sandbox layer

**Bottom Line**

- `allowedWriteRoots` stays.
- Its importance increases.
- The thing you lose is dynamic Deno-enforced filesystem narrowing at daemon launch.
- So yes, compiled distribution means you should explicitly harden and test current `allowedWriteRoots` usage.

Natural next steps:
1. I can audit the current write paths and tell you whether all user-controlled writes already pass through the gate.
2. I can update the distribution task note with a short “permission model after compile” section.
3. I can sketch a compiled-binary permission policy so the release plan is concrete.

# gpt-5.4_2026-03-05_1811_55

Yes, partially.

**Short Answer**

- Today `allowedWriteRoots` is protected twice.
- In a compiled binary, you likely lose the dynamic `deno run --allow-write=<roots>` layer.
- That does **not** make `allowedWriteRoots` obsolete.
- It means `allowedWriteRoots` becomes the **primary app-level write authorization boundary** instead of a second layer behind Deno’s sandbox.

**Current Model**

There are two separate protections today:

- Launch-time Deno sandbox:
  - the launcher builds `--allow-read=...` and `--allow-write=...` from runtime paths, `allowedWriteRoots`, and `providerSessionRoots` in [launcher.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/orchestrator/launcher.ts:112)
- In-app path policy:
  - `WritePathPolicyGate` canonicalizes the target path and denies anything outside configured roots in [path_policy.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/policy/path_policy.ts:96)
  - the daemon wires that gate into the recording pipeline in [main.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/main.ts:390)

Also, `workspace register` currently mutates shared `allowedWriteRoots` and warns that a running daemon may still deny writes until restart in [workspace_register.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/cli/src/commands/workspace_register.ts:39) and [workspace_register.ts](C:/Users/drich/hub/spectacular-voyage/kato/apps/cli/src/commands/workspace_register.ts:215).

**What Changes With `deno compile`**

Official Deno docs say compile-time runtime flags, including permission flags, are applied to the resulting binary: [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/).

That means:
- you can’t keep today’s per-launch dynamic `--allow-write=<whatever is in shared config right now>` model in the same way
- a generic shipped binary will probably need broader compiled-in file permissions than today’s source-launched daemon

Also, runtime permission prompts are not viable for a detached daemon because Deno does not show prompts when stdout/stderr are not a TTY: [Deno security/permissions](https://docs.deno.com/runtime/fundamentals/security/).

**So Do We Have To Address `allowedWriteRoots`?**

Yes, but the answer is “harden it”, not “replace it”.

What needs to change conceptually:
- `allowedWriteRoots` should be treated as the **authoritative product policy** for user-requested output paths
- Deno permission narrowing becomes optional defense-in-depth when running from source
- compiled builds must assume the app gate is the main protection

What does **not** need to change:
- the user-facing concept of `allowedWriteRoots`
- the fact that workspace registration can auto-add workspace roots
- the restart-bound semantics, unless you choose to add live config reload

**Practical Implication**

For compiled binaries, you should verify that every user-controlled write path goes through `WritePathPolicyGate` before any file operation.

That means auditing:
- `record`
- `capture`
- `export`
- any future installer/update/service-generated writes outside Kato-owned directories

You do **not** want to force internal Kato runtime files under `~/.kato` through `allowedWriteRoots`; those are app-owned writes, not user-requested output writes.

**Parallel Read-Scope Issue**

This same issue exists for `providerSessionRoots` on the read side:
- today they help shape `--allow-read=...` in the launcher
- in compiled builds, they become primarily app-level discovery/policy unless you add some other sandbox layer

**Bottom Line**

- `allowedWriteRoots` stays.
- Its importance increases.
- The thing you lose is dynamic Deno-enforced filesystem narrowing at daemon launch.
- So yes, compiled distribution means you should explicitly harden and test current `allowedWriteRoots` usage.

Natural next steps:
1. I can audit the current write paths and tell you whether all user-controlled writes already pass through the gate.
2. I can update the distribution task note with a short “permission model after compile” section.
3. I can sketch a compiled-binary permission policy so the release plan is concrete.

# User_2026-03-05_1819_59

So the distribution binary has to allow all writes, because a user might want to write anywhere on the filesystem. I think it's okay. At least we'll be able to deny network access. 

Yes, please proceed with all next steps #2 and #3.

As opposed to a Windows Installer, we could do a powershell-based install script, like "irm https://deno.land/install.ps1 | iex"

Similarly, "curl -fsSL https://deno.land/install.sh | sh" for Mac and Linux. Unless those are overkill.  

Then would the npm-based wrapper just execut those things? Or what would it look like?

# gpt-5.4_2026-03-05_1820_16

I’m updating the distribution note with an explicit post-compile permission model and install-channel section. I’m also checking the official Deno and npm docs so the script-based installer and npm wrapper recommendations match current platform behavior.

# gpt-5.4_2026-03-05_1820_48

I’m adding three concrete pieces to the note: post-compile permission policy, a direct script-based installer channel, and the actual npm wrapper/package layout. That should make the release plan answerable instead of abstract.

# gpt-5.4_2026-03-05_1822_04

The note now has the compiled-permission model and the script-installer/npm-wrapper story. I’m doing a quick validation pass because these insertions touched the sections that define update, uninstall, and packaging ownership.

# gpt-5.4_2026-03-05_1822_38

Updated [task.2026.2026-03-05-distribution-solutions.md](C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\task.2026.2026-03-05-distribution-solutions.md) with:
- a post-compile permission model
- script-based installer guidance
- the npm wrapper/package shape

**Permission Story**

Per [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/), permission flags are baked into the executable at compile time.

That means:
- the compiled `kato-daemon` cannot keep today’s dynamic per-launch `--allow-read=...` / `--allow-write=...` narrowing
- if Kato supports user-selected output paths anywhere, the compiled daemon likely needs broad write permission
- if provider roots stay configurable, the daemon may also need broad read permission

So yes:
- `allowedWriteRoots` still matters
- it becomes more important, not less

Current state:
- Deno launch flags are one layer in [launcher.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\orchestrator\launcher.ts:112)
- app-level write authorization is the other layer in [path_policy.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\policy\path_policy.ts:96)
- the daemon already uses that gate in [main.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\daemon\src\main.ts:390)

So the compiled-binary model becomes:
- `kato-daemon`: broad read, broad write, no network
- `allowedWriteRoots`: primary app-level guard for user-requested output paths
- `providerSessionRoots`: primary app-level read/discovery policy

Important nuance:
- if you want `kato self-update` inside the CLI, then `kato` probably needs network permission
- if you want both binaries network-denied, self-update must be delegated to an external installer/script/`winget` flow instead

**Install Scripts**

The `curl | sh` / `irm | iex` pattern is reasonable for phase 1. It is not overkill.

Recommended role:
- phase-1 direct install channel
- downloads latest or pinned GitHub release assets
- installs to a user-local program dir
- writes install-channel metadata
- does not put program files inside `~/.kato`

Good split:
- script installers first
- Windows MSI/EXE installer later, for polished uninstall/Apps & Features integration

**npm Wrapper**

The npm wrapper should not run those shell/PowerShell scripts.

Better model:
- top-level `kato` npm package
- platform packages like `@spectacular-voyage/kato-win32-x64`, `...darwin-arm64`, `...linux-x64-gnu`
- top-level package uses `optionalDependencies`, `os`, `cpu`, `libc`
- each platform package contains both `kato` and `kato-daemon`
- top-level `bin` points to a tiny Node launcher script that `spawn()`s the packaged native `kato` binary

Why:
- npm cleanly owns install/uninstall
- no cross-platform shelling-out at install time
- uninstall stays `npm uninstall -g kato`
- no hidden external install side effects

Relevant npm docs:
- [`package.json` `bin`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin)
- [`optionalDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#optionaldependencies)
- [`os`, `cpu`, `libc`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#os)

**Recommendation**

Best near-term path:
1. direct binary release assets
2. `install.sh` and `install.ps1` as first-class installer channels
3. npm wrapper with platform packages
4. JSR for Deno-native users
5. Windows installer after that

I did not run tests; this was a docs-only change.

Natural next steps:
1. I can draft the exact npm package layout and filenames.
2. I can sketch the install-channel metadata file and how `kato` detects `script` vs `npm` vs `jsr` vs `installer`.
3. I can turn the release workflow section into a concrete GitHub Actions design.

# gpt-5.4_2026-03-05_1822_50

Updated [task.2026.2026-03-05-distribution-solutions.md](C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\task.2026.2026-03-05-distribution-solutions.md) with:
- a post-compile permission model
- script-based installer guidance
- the npm wrapper/package shape

**Permission Story**

Per [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/), permission flags are baked into the executable at compile time.

That means:
- the compiled `kato-daemon` cannot keep today’s dynamic per-launch `--allow-read=...` / `--allow-write=...` narrowing
- if Kato supports user-selected output paths anywhere, the compiled daemon likely needs broad write permission
- if provider roots stay configurable, the daemon may also need broad read permission

So yes:
- `allowedWriteRoots` still matters
- it becomes more important, not less

Current state:
- Deno launch flags are one layer in [launcher.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\orchestrator\launcher.ts:112)
- app-level write authorization is the other layer in [path_policy.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\policy\path_policy.ts:96)
- the daemon already uses that gate in [main.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\daemon\src\main.ts:390)

So the compiled-binary model becomes:
- `kato-daemon`: broad read, broad write, no network
- `allowedWriteRoots`: primary app-level guard for user-requested output paths
- `providerSessionRoots`: primary app-level read/discovery policy

Important nuance:
- if you want `kato self-update` inside the CLI, then `kato` probably needs network permission
- if you want both binaries network-denied, self-update must be delegated to an external installer/script/`winget` flow instead

**Install Scripts**

The `curl | sh` / `irm | iex` pattern is reasonable for phase 1. It is not overkill.

Recommended role:
- phase-1 direct install channel
- downloads latest or pinned GitHub release assets
- installs to a user-local program dir
- writes install-channel metadata
- does not put program files inside `~/.kato`

Good split:
- script installers first
- Windows MSI/EXE installer later, for polished uninstall/Apps & Features integration

**npm Wrapper**

The npm wrapper should not run those shell/PowerShell scripts.

Better model:
- top-level `kato` npm package
- platform packages like `@spectacular-voyage/kato-win32-x64`, `...darwin-arm64`, `...linux-x64-gnu`
- top-level package uses `optionalDependencies`, `os`, `cpu`, `libc`
- each platform package contains both `kato` and `kato-daemon`
- top-level `bin` points to a tiny Node launcher script that `spawn()`s the packaged native `kato` binary

Why:
- npm cleanly owns install/uninstall
- no cross-platform shelling-out at install time
- uninstall stays `npm uninstall -g kato`
- no hidden external install side effects

Relevant npm docs:
- [`package.json` `bin`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#bin)
- [`optionalDependencies`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#optionaldependencies)
- [`os`, `cpu`, `libc`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#os)

**Recommendation**

Best near-term path:
1. direct binary release assets
2. `install.sh` and `install.ps1` as first-class installer channels
3. npm wrapper with platform packages
4. JSR for Deno-native users
5. Windows installer after that

I did not run tests; this was a docs-only change.

Natural next steps:
1. I can draft the exact npm package layout and filenames.
2. I can sketch the install-channel metadata file and how `kato` detects `script` vs `npm` vs `jsr` vs `installer`.
3. I can turn the release workflow section into a concrete GitHub Actions design.
