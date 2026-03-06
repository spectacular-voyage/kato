---
id: distribution-solutions-1198662a
title: 'Distribution Solutions'
desc: ''
created: 1772765534665
updated: 1772765534665
kato-sessionIds: [019cc0ce-265f-7ba3-8cc4-b1f70c944c9b]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [1198662a-0e8f-4869-aeeb-d972799cff95]
conversationEventKinds: [message.user, message.assistant, tool.call, tool.result]
participants: [codex.gpt-5.4]
---

# User_2026-03-05_1852_14

With the install scripts, do we have to add the binaries to path? What's involved in changing the "kato start/stop" to optionally targeting binaries, but in development continuing to support the deno call method.

# gpt-5.4_2026-03-05_1852_30

I’m checking the CLI start/restart path now, because most of this is probably just a launcher swap. `stop` may not care about binaries at all if it only talks through the control/status files.

# gpt-5.4_2026-03-05_1853_09

No, you do not have to add both binaries to `PATH`.

**PATH**

Recommended split:
- `kato`: yes, for normal CLI UX
- `kato-daemon`: no, not necessarily

Best install shape:
- put both binaries in the same install directory
- make only `kato` discoverable from `PATH`
- have `kato` locate `kato-daemon` by sibling path or configured override

So an install script can:
- install `kato` and `kato-daemon` to something like `~/.local/bin` or a user-local program dir
- add only the directory containing `kato` to `PATH`
- let the CLI find `kato-daemon` by absolute path

If the script installs to a directory already on `PATH`, then it does not need to modify `PATH` at all.

Good Unix options:
- install directly into `~/.local/bin` if it exists and is on `PATH`
- otherwise install into `~/.local/share/kato/bin` and print shell-profile instructions, or append them

Good Windows option:
- install into `%LOCALAPPDATA%\Programs\Kato\bin`
- append that directory to the user `PATH`
- `kato-daemon.exe` can sit there too; it does not need separate PATH treatment

**What’s Involved In Supporting Binaries For `start`/`restart`**

Less than it looks.

`start` already just calls a launcher abstraction:
- [start.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\cli\src\commands\start.ts:74)

`restart` just does `stop`, waits, then `start`:
- [restart.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\cli\src\commands\restart.ts:66)

`stop` does not launch anything at all. It just writes to the control queue / status:
- [stop.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\cli\src\commands\stop.ts:46)

So the real change is mostly in launcher selection, not command semantics.

**Current State**

Today the router creates:
- `new DenoDetachedDaemonLauncher(effectiveRuntime)`
- in [router.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\cli\src\router.ts:509)

And that launcher runs:
- `deno run ... apps/daemon/src/main.ts __daemon-run`
- in [launcher.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\orchestrator\launcher.ts:133)

**What To Change**

Add a second launcher implementation, for example:
- `ExecutableDaemonLauncher`

It would implement the same interface:
- `DaemonProcessLauncherLike`
- in [launcher.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\orchestrator\launcher.ts:5)

Then add a resolver/factory that chooses between:
1. explicit override like `KATO_DAEMON_BIN`
2. sibling installed binary next to `kato`
3. current Deno source launcher as development fallback

That means:
- `start.ts` stays unchanged
- `restart.ts` stays unchanged
- `stop.ts` stays unchanged
- router/factory logic changes
- launcher tests expand

**Development Fallback**

Recommended precedence:
1. `KATO_DAEMON_BIN`
2. sibling executable next to current `kato`
3. source-tree fallback using current Deno launcher

That gives you:
- installed binary behavior in production
- source-tree behavior in development
- a manual escape hatch for testing

**What The Binary Launcher Does**

On macOS/Linux:
- `Deno.Command(<daemon-binary-path>, { ... }).spawn()`

On Windows:
- same detached strategy you already use with `Start-Process`
- but `FilePath` becomes `kato-daemon.exe`, not `deno.exe`
- the current PowerShell detachment logic is reusable:
  - [launcher.ts](C:\Users\drich\hub\spectacular-voyage\kato\apps\runtime\src\orchestrator\launcher.ts:68)

**One Important UX Detail**

The daemon binary should accept a startup mode that works in both worlds.

Good options:
- installed binary defaults to “run daemon” with no args
- source entrypoint still accepts `__daemon-run`
- or both accept a stable `run`

That avoids weird branching in the CLI.

**About The Install Scripts**

Your `curl | sh` / `irm | iex` scripts are a good direct-install channel.

They should not be what npm runs.

**npm Wrapper Story**

The npm wrapper should not execute those install scripts.

Better model:
- npm installs package-managed binaries
- top-level `kato` npm package contains a tiny Node launcher
- platform-specific packages contain `kato` + `kato-daemon`
- Node launcher finds packaged binary and `spawn()`s it

So:
- direct install scripts are for “download/install from GitHub releases”
- npm wrapper is for “install through npm”
- they are separate channels with separate ownership

That keeps uninstall sane:
- script install: script/uninstall helper removes files it installed
- npm install: `npm uninstall -g kato` removes npm-managed files

**What I’d Implement**

1. Add `resolveDaemonLaunchTarget()` with precedence:
   - `KATO_DAEMON_BIN`
   - sibling `kato-daemon[.exe]`
   - source-tree fallback
2. Add `ExecutableDaemonLauncher`
3. Keep `DaemonProcessLauncherLike` as the seam
4. Leave `start`/`stop`/`restart` logic alone
5. Add install metadata later only if you need channel-aware self-update/uninstall

Natural next steps:
1. I can sketch the exact resolver API and launcher classes.
2. I can draft the install script behavior for Unix and Windows.
3. I can map out the npm package structure in concrete filenames and `package.json` fields.

# User_2026-03-05_1853_38

Say more about "top-level bin points to a tiny Node launcher script that spawn()s the packaged native kato binary"

# gpt-5.4_2026-03-05_1854_36

It means the npm-installed `kato` command is just a very small JavaScript entrypoint whose whole job is:

1. find the correct native binary that npm already installed
2. run it with the same args/stdin/stdout/stderr
3. exit with the same status code

So npm is only the installer/command shim layer. Kato itself still runs as a native executable.

**Why do this at all?**

Because the top-level `kato` npm package is cross-platform, but the actual native binary is platform-specific.

So the pattern is:

- `kato` package
  - gives you the stable `kato` command
  - contains a tiny Node launcher
  - depends on platform packages via `optionalDependencies`
- platform packages
  - contain real binaries for one OS/arch
  - e.g. `@spectacular-voyage/kato-win32-x64`
  - e.g. `@spectacular-voyage/kato-darwin-arm64`

npm installs the matching platform package for the current machine, then the JS launcher finds it and `spawn()`s it.

**Why not point `bin` directly at the native binary?**

Because the top-level package does not know at publish time which platform binary file will exist on the target machine.

A JS launcher solves that cleanly:
- one stable `kato` command
- one package name users install
- no shell-specific scripting
- no install-time network fetches
- uninstall stays `npm uninstall -g kato`

**What the top-level package looks like**

Example:

```json
{
  "name": "kato",
  "version": "0.3.0",
  "bin": {
    "kato": "./bin/kato.js"
  },
  "optionalDependencies": {
    "@spectacular-voyage/kato-win32-x64": "0.3.0",
    "@spectacular-voyage/kato-darwin-arm64": "0.3.0",
    "@spectacular-voyage/kato-darwin-x64": "0.3.0",
    "@spectacular-voyage/kato-linux-x64-gnu": "0.3.0"
  }
}
```

npm will skip the non-matching optional deps.

**What a platform package looks like**

Example:

```json
{
  "name": "@spectacular-voyage/kato-win32-x64",
  "version": "0.3.0",
  "os": ["win32"],
  "cpu": ["x64"],
  "files": [
    "bin/kato.exe",
    "bin/kato-daemon.exe"
  ]
}
```

Same idea for macOS/Linux packages.

**What the launcher script does**

Something like this:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const candidates = [
  "@spectacular-voyage/kato-win32-x64",
  "@spectacular-voyage/kato-darwin-arm64",
  "@spectacular-voyage/kato-darwin-x64",
  "@spectacular-voyage/kato-linux-x64-gnu",
];

for (const pkg of candidates) {
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const dir = path.dirname(pkgJson);
    const exe = path.join(dir, "bin", process.platform === "win32" ? "kato.exe" : "kato");
    const daemon = path.join(
      dir,
      "bin",
      process.platform === "win32" ? "kato-daemon.exe" : "kato-daemon"
    );

    const child = spawn(exe, process.argv.slice(2), {
      stdio: "inherit",
      env: {
        ...process.env,
        KATO_DAEMON_BIN: daemon
      }
    });

    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });

    child.on("error", (err) => {
      console.error(`Failed to start kato: ${err.message}`);
      process.exit(1);
    });

    break;
  } catch {
    // try next candidate
  }
}
```

**Important detail**

The launcher can set `KATO_DAEMON_BIN` before starting `kato`.

That’s useful because:
- `kato-daemon` does not need to be on `PATH`
- the native `kato` binary can launch the correct sibling daemon immediately
- npm ownership stays clear

**What happens when the user types `kato start`**

Flow:

1. npm shim runs `bin/kato.js`
2. `kato.js` finds the installed platform package
3. `kato.js` spawns the native `kato` binary
4. native `kato` sees `KATO_DAEMON_BIN`
5. native `kato start` launches that daemon binary
6. `stop`/`status` still work through shared files, same as now

**Why this is better than running install scripts from npm**

Because npm remains the owner of installed files.

If npm called `install.sh`/`install.ps1`:
- files might get installed outside npm’s control
- uninstall becomes messy
- version ownership becomes unclear
- npm lockfile behavior becomes less meaningful

With the tiny launcher approach:
- npm installs files into `node_modules`
- npm creates the command shim
- npm removes everything on uninstall

**So the npm wrapper is not an installer script**

Correct.

It is:
- a command adapter
- plus package selection

It is not:
- a curl/PowerShell installer
- a downloader at runtime
- a compile step

If you want, I can next draft:
1. the exact npm package tree
2. the launcher file
3. the corresponding `KATO_DAEMON_BIN` resolver design on the Kato side

# gpt-5.4_2026-03-05_1854_41

It means the npm-installed `kato` command is just a very small JavaScript entrypoint whose whole job is:

1. find the correct native binary that npm already installed
2. run it with the same args/stdin/stdout/stderr
3. exit with the same status code

So npm is only the installer/command shim layer. Kato itself still runs as a native executable.

**Why do this at all?**

Because the top-level `kato` npm package is cross-platform, but the actual native binary is platform-specific.

So the pattern is:

- `kato` package
  - gives you the stable `kato` command
  - contains a tiny Node launcher
  - depends on platform packages via `optionalDependencies`
- platform packages
  - contain real binaries for one OS/arch
  - e.g. `@spectacular-voyage/kato-win32-x64`
  - e.g. `@spectacular-voyage/kato-darwin-arm64`

npm installs the matching platform package for the current machine, then the JS launcher finds it and `spawn()`s it.

**Why not point `bin` directly at the native binary?**

Because the top-level package does not know at publish time which platform binary file will exist on the target machine.

A JS launcher solves that cleanly:
- one stable `kato` command
- one package name users install
- no shell-specific scripting
- no install-time network fetches
- uninstall stays `npm uninstall -g kato`

**What the top-level package looks like**

Example:

```json
{
  "name": "kato",
  "version": "0.3.0",
  "bin": {
    "kato": "./bin/kato.js"
  },
  "optionalDependencies": {
    "@spectacular-voyage/kato-win32-x64": "0.3.0",
    "@spectacular-voyage/kato-darwin-arm64": "0.3.0",
    "@spectacular-voyage/kato-darwin-x64": "0.3.0",
    "@spectacular-voyage/kato-linux-x64-gnu": "0.3.0"
  }
}
```

npm will skip the non-matching optional deps.

**What a platform package looks like**

Example:

```json
{
  "name": "@spectacular-voyage/kato-win32-x64",
  "version": "0.3.0",
  "os": ["win32"],
  "cpu": ["x64"],
  "files": [
    "bin/kato.exe",
    "bin/kato-daemon.exe"
  ]
}
```

Same idea for macOS/Linux packages.

**What the launcher script does**

Something like this:

```js
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const candidates = [
  "@spectacular-voyage/kato-win32-x64",
  "@spectacular-voyage/kato-darwin-arm64",
  "@spectacular-voyage/kato-darwin-x64",
  "@spectacular-voyage/kato-linux-x64-gnu",
];

for (const pkg of candidates) {
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const dir = path.dirname(pkgJson);
    const exe = path.join(dir, "bin", process.platform === "win32" ? "kato.exe" : "kato");
    const daemon = path.join(
      dir,
      "bin",
      process.platform === "win32" ? "kato-daemon.exe" : "kato-daemon"
    );

    const child = spawn(exe, process.argv.slice(2), {
      stdio: "inherit",
      env: {
        ...process.env,
        KATO_DAEMON_BIN: daemon
      }
    });

    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });

    child.on("error", (err) => {
      console.error(`Failed to start kato: ${err.message}`);
      process.exit(1);
    });

    break;
  } catch {
    // try next candidate
  }
}
```

**Important detail**

The launcher can set `KATO_DAEMON_BIN` before starting `kato`.

That’s useful because:
- `kato-daemon` does not need to be on `PATH`
- the native `kato` binary can launch the correct sibling daemon immediately
- npm ownership stays clear

**What happens when the user types `kato start`**

Flow:

1. npm shim runs `bin/kato.js`
2. `kato.js` finds the installed platform package
3. `kato.js` spawns the native `kato` binary
4. native `kato` sees `KATO_DAEMON_BIN`
5. native `kato start` launches that daemon binary
6. `stop`/`status` still work through shared files, same as now

**Why this is better than running install scripts from npm**

Because npm remains the owner of installed files.

If npm called `install.sh`/`install.ps1`:
- files might get installed outside npm’s control
- uninstall becomes messy
- version ownership becomes unclear
- npm lockfile behavior becomes less meaningful

With the tiny launcher approach:
- npm installs files into `node_modules`
- npm creates the command shim
- npm removes everything on uninstall

**So the npm wrapper is not an installer script**

Correct.

It is:
- a command adapter
- plus package selection

It is not:
- a curl/PowerShell installer
- a downloader at runtime
- a compile step

If you want, I can next draft:
1. the exact npm package tree
2. the launcher file
3. the corresponding `KATO_DAEMON_BIN` resolver design on the Kato side

# User_2026-03-05_1933_18

OK, please fill out [task.2026.2026-03-05-distribution-solutions.md](dev-docs/notes/task.2026.2026-03-05-distribution-solutions.md) using my Task note guidelines (in [dev.general-guidance.md](dev-docs/notes/dev.general-guidance.md) )

# gpt-5.4_2026-03-05_1933_31

Reading the task-note guidance first, then I’ll reshape the distribution note to match that format instead of just accumulating decisions and prose.

# gpt-5.4_2026-03-05_1933_58

The target note changed unexpectedly while I was reading it.

A moment ago [task.2026.2026-03-05-distribution-solutions.md](C:\Users\drich\hub\spectacular-voyage\kato\dev-docs\notes\task.2026.2026-03-05-distribution-solutions.md) contained the distribution planning content we’d been refining; now it appears to have been replaced with a new frontmatter-only file with a different `id` and title.

How do you want me to proceed: restore and reformat the fuller distribution note into the task-note structure, or treat this new empty note as the source of truth and rewrite it from scratch?