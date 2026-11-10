---
id: oibsmv7gch91fi01td75133
title: Platform Migration
desc: Move Kato Web off Fresh, make the code runtime-portable, and switch runtimes before Deno 2.9 LTS ends in about October 2027.
updated: 1794331172773
created: 1794331172773
---

## Goal

Kato keeps shipping on supported foundations after Fresh 2 and the Deno runtime stop being developed. Every stage ends in a releasable Kato, and the irreversible step (the runtime switch) comes last, after a dated checkpoint.

## Summary

State as of 2026-11-10:

| Component | Status | Horizon |
|---|---|---|
| Fresh 2 (`@fresh/core`) | Last release 2.3.3 (2026-04-28); no merge to `main` since 2026-06-03; repo moved to `freshframework/fresh`; pins Preact 10 ([#3911](https://github.com/freshframework/fresh/issues/3911), no reply) | Already past |
| Fresh 3 (`@frsh/fresh`) | npm alpha, one developer, Vite + Nitro + Preact 11 | Not a foundation |
| Deno runtime | Team joined Cloudflare 2026-10-09 ([Deno blog](https://deno.com/blog/cloudflare)); monthly 2.9.x fix releases, no features, no Deno 3 ([denoland/deno#37030](https://github.com/denoland/deno/issues/37030)) | About October 2027 |
| `jsr:@std/*` | No commits since 2026-09-25; maintainer not stated | Unknown; pure TypeScript, low risk |
| JSR | Continues on Cloudflare infrastructure | No roadmap |

Kato's exposure (from a repository inventory on 2026-11-10):

- **Fresh:** 12 import sites (`Head` in 9 routes, `createDefine`, `App`/`staticFiles`, the Vite plugin), 21 route files (about 2.4k lines), 4 middlewares. No Partials, client navigation, `ctx.render`, or `HttpError`. `apps/web/src` (48 files, 8.4k lines) has no Fresh imports; the 8 islands use only `preact/hooks` and poll JSON endpoints.
- **Deno:** about 480 `Deno.*` references in production code (366 in 53 app files, 112 in scripts), about 1,965 in tests, 959 `Deno.test` registrations; no platform abstraction. Hardest to port: `Deno.watchFs`, seek-based JSONL reads, `ino`/`mtime`/`birthtime` change detection, `createNew`, raw stdin and `consoleSize`, `Deno.kill(pid, 0)`.
- **Order is forced:** Fresh's generated server bundle calls `Deno.serve`, `Deno.readTextFile`, and `Deno.stat` directly, so Fresh must go before Deno. Leaving Fresh does not require leaving Deno.

## Decisions

See [[dev.decision-log]] "Platform Direction After Deno and Fresh".

- Replace Fresh with Hono, server-side Preact rendering, a small in-repo island hydrator, and Vite for the client bundle only; keep the server-rendered pages and post/redirect/get forms rather than rebuilding Kato Web as a single-page app.
- Make the code portable to `node:*` APIs while Deno still runs it.
- Target Node as the reference runtime (plain JavaScript on npm, one merged single-executable binary per platform on GitHub Releases), with Bun `--compile` as the fallback compiler; confirm at the checkpoint.
- Stay on the Deno 2.9 LTS line until the switch: CI on `v2.9.x`, releases on an exact 2.9 patch, bumped deliberately each month.

## Contract Changes

- Stage 0: none. Developer guidance ([[dev.general-guidance]]) now prefers Web-standard and `node:*` APIs over `Deno.*`, and runtime-neutral npm packages over `jsr:@std/*`.

## Testing

Stage 0 baseline, before any porting (PR #55, Deno 2.9.x):

| Platform | Root suite | Kato Web tests |
|---|---|---|
| ubuntu-latest | 978 passed | 10 passed |
| macos-latest | 978 passed | 10 passed |
| windows-latest | 977 passed, 1 ignored | 10 passed |

The test ignored on Windows is "PersistentSessionStateStore migrates legacy colon storage keys" (`tests/session-state-store_test.ts`), since colons are not valid in Windows filenames.

## Open Issues

- **Archive the `denort` runtimes.** `deno compile` downloads `denort-<target>.zip` from dl.deno.land; `DENORT_BIN` overrides that. The LTS year itself depends on dl.deno.land, so this is insurance for a slip toward October 2027 or an announced shutdown. Deferred because hosting the archives means a user-visible toolchain release in this repository.
- **`loglayer` in compiled binaries.** `loglayer_adapter.ts` loads `loglayer` through `import()` of a variable specifier, which `deno compile` likely cannot include, so release binaries probably always use the JSONL fallback. Settle in stage 2: make it a static import or drop it.
- **`ino` on Windows.** `sameFileStamp` in `session_state_store.ts` trusts `ino` whenever it is not null. Under Node, `ino` is always a number, including Windows file indexes; decide deliberately whether to trust them before the switch.
- **Parameter properties.** 15 production constructors use parameter properties, which Node's type stripping cannot run unbundled.
- **Node SEA on macos-x64** is reported to segfault (one source); verify before committing to Node binaries for that target.
- **Merged binary.** Merging `kato`, `kato-daemon`, and `kato-web` would cut download size about threefold, but on Deno it would give the daemon the CLI's permissions, which [[dev.security-baseline]] forbids. Merge only as part of the switch.

## Implementation Plan

### Stage 0: hygiene (Deno 2.9.x)

- [x] CI on Deno `v2.9.x`; release workflow pinned to `2.9.8`; lockfiles regenerated with 2.9.8.
- [x] Run the root suite and the Kato Web tests on Windows and macOS in CI.
- [x] Bring `apps/web/tests` into `deno task ci` and CI (`deno task test:web`).
- [x] Drop the unused `@preact/signals` import-map entry (`loglayer` is used; see Open Issues).
- [x] Replace the "Deno-first" guidance; record the direction in [[dev.decision-log]].
- [ ] Archive the `denort` runtimes and set `DENORT_BIN` in release jobs (deferred; see Open Issues).

### Stage 1: leave Fresh (Deno 2.9.x)

Design and detailed plan: [[task.2026.2026-11-10-leave-fresh]].

- [ ] Hono routing and middleware with Preact SSR and the island hydrator, still on Preact 10; route tests move to `app.request()`.
- [ ] Standard automatic JSX runtime (`jsxImportSource: "preact"`) instead of Deno's `precompile`.
- [ ] Serve the Vite client build through an `AssetSource` seam, embedded with `--include dist` on Deno. (A generated asset module moves to stage 3, where Bun or Node binaries need it.)
- [ ] Remove `@fresh/*` from every lockfile.
- [ ] Upgrade to Preact 11 as its own change.

### Stage 2: portability (Deno 2.9.x)

- [ ] Platform module over `node:*` for fs, errors, process, TTY, and network; port the app call sites.
- [ ] Replace `@std/path`, `@std/cli`, and `@std/yaml` (golden round-trip tests for YAML first); vendor or shim `@std/assert`.
- [ ] `package.json` workspace instead of the five import maps; untangle the daemon/runtime relative-import shims.
- [ ] Rewrite the parameter-property constructors.

### Checkpoint (about April 2027)

- [ ] Review Deno foundation news, a 72-hour-plus Windows soak test of `kato-daemon` under Node and Bun, and release-binary download counts; choose the runtime and compiler.

### Stage 3: switch (before October 2027)

- [ ] Port tests to vitest; replace `deno check`, `deno lint`, `deno fmt`, and `deno audit`.
- [ ] Bundle one entry point; ship plain JavaScript on npm and single-executable binaries on GitHub Releases.
- [ ] Rewrite [[dev.security-baseline]] around the new runtime's permission flags and Kato's path policy.
