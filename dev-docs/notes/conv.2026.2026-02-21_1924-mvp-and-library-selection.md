---
id: snokkxvsm6x7ql18t0vizjm
title: 2026 02 21_1924 Mvp and Library Selection
desc: ''
updated: 1771730707676
created: 1771730707676
---

# User_2026-02-22_1034_12

Let's Decide CLI + logging libraries first, with MVP-safe defaults and rationale recorded in the note: @mvp

::record [conv.2026.2026-02-21_1924-mvp-and-library-selection.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md)

# gpt-5.3-codex_2026-02-22_1034_12

Locked for MVP and recorded.

- CLI library/default: use Deno std parsing (`@std/cli`) with a small in-repo router for `start|stop|status|clean|export`; no Cliffy in MVP.
- Logging library/default: no third-party logger in MVP; use in-repo structured logging with JSONL and separate operational vs security-audit sinks.

Rationale captured:
- Keeps dependency/supply-chain surface minimal.
- Aligns with strict command grammar and fail-closed behavior.
- Aligns with security baseline requirement to separate audit logs.

Updated notes:
- `dev-docs/notes/task.2026.2026-02-22-mvp-epic-library-selection.md:30`
- `dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md:13`

No tests were run (docs-only changes).

1. If you want, I can now scaffold `apps/daemon/src/cli` to match the chosen CLI default.
2. I can also scaffold `apps/daemon/src/observability/logger.ts` + `audit_logger.ts` with the JSONL schemas.

# User_2026-02-22_1034_12

Let's also analyze the old code base under /stenobot and look for other opportunities to improve or simplify our approach. Nothing is off limits in terms of rearchitecture: given we have a new approach with other applications in the mix and other libraries to substitue.

# gpt-5.3-codex_2026-02-22_1034_12

Strong call. The old `stenobot` code shows several clear simplification opportunities for Kato.

**Highest-impact opportunities**
1. Split the monolithic monitor into explicit pipeline stages. `SessionMonitor` currently does discovery, watcher management, command parsing, path resolution, export writing, and state mutation in one class (`stenobot/src/core/monitor.ts:46`, `stenobot/src/core/monitor.ts:103`, `stenobot/src/core/monitor.ts:327`, `stenobot/src/core/monitor.ts:387`).  
Use: `ingest -> normalize -> command-policy -> write-jobs -> writer`.

2. Enforce strict command grammar + path policy at one gate. Old detector is intentionally permissive/natural-language tolerant (`stenobot/src/core/detector.ts:3`, `stenobot/src/core/detector.ts:29`), and output path resolution has no allowlist/canonicalization checks (`stenobot/src/core/monitor.ts:387`).  
For Kato, make command parsing strict-default and run every write through canonical path policy.

3. Replace PID/lock orchestration sprawl with one lifecycle service. Start/stop/restart duplicate process checks and lock semantics (`stenobot/src/cli/commands/start.impl.ts:22`, `stenobot/src/cli/commands/stop.impl.ts:12`, `stenobot/src/cli/commands/restart.impl.ts:11`).  
Use a single daemon control channel (socket/IPC) and keep CLI as a thin client.

4. Remove full-file reparsing for Claude sessions. Claude parser reads entire file on each parse (`stenobot/src/providers/claude-code/parser.ts:233`) while monitor also keeps per-session watchers (`stenobot/src/core/monitor.ts:150`) and rescans discovery (`stenobot/src/core/monitor.ts:104`).  
Move to streaming append reads + durable checkpoints.

5. Stop reparsing raw provider files in UI-style commands. `status` and `clean` re-open/parse session files for labels (`stenobot/src/cli/commands/status.impl.ts:39`, `stenobot/src/cli/commands/clean.impl.ts:20`).  
Persist normalized display metadata once during ingest and read from state/snapshots.

6. Fix correctness drifts before extending architecture. Codex messages use parse-time `new Date()` timestamps (`stenobot/src/providers/codex/parser.ts:74`), and config/state are fail-open on parse errors (`stenobot/src/config.ts:128`, `stenobot/src/core/state.ts:29`).  
For Kato, fail closed on invalid config and preserve deterministic timestamps from source events.

7. Trim dependency surface aggressively. Old stack carries many Node-era libs (`stenobot/package.json:40`), while some appear unused in src/tests (`prompts`, `zod`).  
This aligns with your MVP direction: std CLI + in-repo structured logging.

**Library substitutions (recommended)**
1. CLI: keep `@std/cli` + in-repo router (already aligned).
2. Logging: in-repo JSONL logger + dedicated audit sink (already aligned).
3. File watching: prefer Deno-native watch/poll strategy, not chokidar-style fanout.
4. Time formatting: native `Intl`/simple formatter instead of `date-fns` unless a hard requirement appears.
5. IDs/frontmatter: `crypto.randomUUID()` over `nanoid` unless compact IDs are mandatory.
6. Config validation: explicit schema validation in daemon bootstrap; no silent fallback.

**Best rearchitecture fit to your monorepo**
1. `apps/daemon`: parser workers + policy engine + writer workers + lifecycle control.
2. `shared/src`: normalized event contracts, command grammar AST, policy decision envelope, status snapshot schema.
3. `apps/web`: read-only view over daemon status snapshots only.
4. `apps/cloud`: aggregation and central policy distribution using shared contracts.

If you want, I can convert this into a concrete “Phase 1/2 migration blueprint” note under `dev-docs/notes/` with implementation slices and test gates.

# User_2026-02-22_1034_12

::capture [conv.2026.2026-02-21_1924-mvp-and-library-selection.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md)

# gpt-5.3-codex_2026-02-22_1034_12

Captured. The command and this response are now recorded in `dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md`.

# User_2026-02-22_1034_12

Have you read [dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md) ? You're supposed to ignore commands. (ie., I have stenobot running already).

Regarding open questions:

If "service mode" refers to running as Windows Service or System.d or whatever, let's completely defer that. I'm in WSL2 so don't even have a systemd-capable place to test. 

With OpenFeature, I think we might as well do that from the start?

# gpt-5.3-codex_2026-02-22_1034_12

Yes. You’re correct on `dev.general-guidance.md`, and I’ll ignore control-command lines (`::capture`, `::record`, etc.) unless you ask to discuss command behavior.

I applied your decisions:

- Deferred service-manager mode (systemd/launchd/Windows Service) to post-MVP.
- OpenFeature included from MVP start.

Updated docs:

- `dev-docs/notes/task.2026.2026-02-22-mvp-epic-library-selection.md:23`
- `dev-docs/notes/task.2026.2026-02-22-mvp-epic-library-selection.md:31`
- `dev-docs/notes/task.2026.2026-02-22-mvp-epic-library-selection.md:39`
- `dev-docs/notes/dev.decision-log.md:91`
- `dev-docs/notes/dev.decision-log.md:104`

No tests were run (docs-only changes).

# User_2026-02-22_1034_12

I renamed the "mvp" task file to [task.2026.2026-02-22-migration-and-mvp-sequencing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md) You can add your "Highest-impact opportunities" and library substitutions there.

Regarding the rearchitecture,  you don't mention the CLI, which is used to control the daemon and do one-off stuff like status, export and clean.

# gpt-5.3-codex_2026-02-22_1034_12

You’re right on both points.

I updated `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md` to include:

- “Highest-Impact Opportunities” from the `stenobot` audit (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:29`)
- “Library Substitutions (MVP-Safe)” (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:40`)
- Explicit CLI role in rearchitecture (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:50`) including daemon control plus one-off commands (`status`, `export`, `clean`)

I also tightened sequencing so CLI wiring is a first-class step (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:22`).

No tests were run (docs-only change).

# User_2026-02-22_1034_12

Are we ready to start the migration/initial implementation?

# gpt-5.3-codex_2026-02-22_1034_12

Yes, we’re ready to start.

Current readiness is solid in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:20` and `dev-docs/notes/dev.decision-log.md:18`:
- CLI/logging/file-watching/config/OpenFeature decisions are set.
- Service mode is explicitly deferred.
- CLI role is explicit (`start`, `stop`, `status`, `export`, `clean`).

Only unresolved item is Sentry scope (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:73`), but it’s not a blocker for migration/initial implementation.

If you want, I can start now with tranche 1:
1. `apps/daemon/src/cli` router + command handlers (`start|stop|status|export|clean`)
2. `apps/daemon/src/observability` logger + audit logger
3. `apps/daemon/src/core/watcher.ts` (`Deno.watchFs` + debounce)
4. baseline tests for CLI parsing and fail-closed behavior

# User_2026-02-22_1034_12

Sentry comes later. Please proceed.

# gpt-5.3-codex_2026-02-22_1034_12

I hit a permission mismatch: your `deno task test` is read-only, while my first CLI round-trip tests wrote temp state files. I’m switching those tests to an injected in-memory state store so we keep your stricter test permissions unchanged.

# User_2026-02-22_1034_12

::capture [conv.2026.2026-02-21_1924-mvp-and-library-selection.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md)

# gpt-5.3-codex_2026-02-22_1034_20

Ignoring that control-command line per `dev.general-guidance.md` and continuing implementation/verification. I just finished converting CLI tests to in-memory state; next I’ll rerun the full test/CI pass.

# gpt-5.3-codex_2026-02-22_1036_10

Implemented tranche 1 and kept Sentry out of scope.

**What’s now in place**
1. CLI scaffolding with strict, fail-closed parsing and routing for `start|stop|status|export|clean`.
`apps/daemon/src/cli/parser.ts:14`  
`apps/daemon/src/cli/router.ts:65`  
`apps/daemon/src/cli/commands/start.ts:3`  
`apps/daemon/src/cli/commands/stop.ts:3`  
`apps/daemon/src/cli/commands/status.ts:4`  
`apps/daemon/src/cli/commands/export.ts:3`  
`apps/daemon/src/cli/commands/clean.ts:10`

2. In-repo observability baseline with structured JSONL logger + audit logger abstractions.
`apps/daemon/src/observability/logger.ts:1`  
`apps/daemon/src/observability/audit_logger.ts:1`

3. Deno-native watcher utility with debounce accumulator.
`apps/daemon/src/core/watcher.ts:1`

4. Daemon main entry now executes CLI.
`apps/daemon/src/main.ts:20`

5. Module exports wired for new CLI/observability/watcher surfaces.
`apps/daemon/src/mod.ts:1`

6. Added `@std/cli` import and lock update.
`deno.json:15`  
`deno.lock`

7. Baseline tests for CLI fail-closed behavior and watcher debounce logic.
`tests/daemon-cli_test.ts:1`  
`tests/daemon-watcher_test.ts:1`

**Validation**
- `deno task ci` passed.
- Test result: `31 passed, 0 failed`.

I also ignored the `::capture ...` line per `dev.general-guidance.md` command-handling rules.

I noticed unrelated working-tree edits in docs (`dev-docs/notes/dev.product-vision.md`, `dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md`) and left them untouched.

# User_2026-02-22_1047_15

Before proceeding, please review [conv.2026.2026-02-22-claude-stenobot-codebase-analysis.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-22-claude-stenobot-codebase-analysis.md) and let me know if there's anything in there worth discussing or integrating into [task.2026.2026-02-22-migration-and-mvp-sequencing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md)

# gpt-5.3-codex_2026-02-22_1047_15

I’ll review that Claude analysis note against the current migration/MVP sequencing task and call out concrete items that should be integrated, plus any points that are better left as discussion first. I’m reading both notes side-by-side now.

# gpt-5.3-codex_2026-02-22_1047_27

Yes. There are several items in `dev-docs/notes/conv.2026.2026-02-22-claude-stenobot-codebase-analysis.md` worth integrating into `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md`.

**Integrate now**
- Preserve parser invariants explicitly as migration acceptance criteria (Claude/Codex behaviors called out around `conv...md:33-37`).
- Add command-detector hardening item: skip fenced code blocks, not just inline backticks (`conv...md:74-75`).
- Add explicit MVP CLI/Web status transport choice: atomic status file first (`conv...md:102-107`).
- Add provider-checkpoint abstraction note: allow non-byte offsets (Gemini JSON array index model) (`conv...md:182-184`).
- Add writer-rotation ordering requirement: policy decision before starting new writer (`conv...md:108-109`).
- Add exporter dedupe guard as a carry-forward behavior (`conv...md:42`).

**Worth discussing first**
- `zod` vs inline guards conflict (`conv...md:96` vs locked decision in `dev-docs/notes/dev.decision-log.md:76`).
- Parser-first migration order (`conv...md:114-127`) vs your current sequencing and work already started in `task...md:22-27`.

**Probably skip/outdated**
- “tests import providers that don’t exist yet” is stale (`conv...md:116`) because parser/provider scaffolding is already present in this repo.
- `decodeProjectDir` issue is mostly legacy unless we re-port that specific logic directly (`conv...md:67`).

If you want, I can patch `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md` now with a short “Imported from Claude analysis” section containing the integrate-now items.

# User_2026-02-22_1048_43

Let's definitely leave out decodeProjectDir, that should be unneeded and left behind.

Please frame the zod vs inline guards discussion.

# gpt-5.3-codex_2026-02-22_1049_06

Agreed on `decodeProjectDir`: we should leave it behind and not port it.

For `zod` vs inline guards, here’s a clean decision frame:

**Decision Question**
- Where do we want runtime schema validation in MVP: external boundaries only, or throughout internal code paths?

**Non-Negotiables**
- `dev.security-baseline` requires schema-validated config/state load and fail-closed behavior.
- Keep dependency surface minimal.
- Keep parser hot paths fast/simple.

**Options**
1. `zod` everywhere  
- Pros: consistent API, rich errors, strong inferred types.  
- Cons: broader dependency footprint, overkill in hot parser loops.

2. Inline guards everywhere  
- Pros: zero extra dependency, very explicit, fast.  
- Cons: repetitive, inconsistent errors, harder to maintain as schemas grow.

3. Hybrid (recommended)  
- Use `zod` at external trust boundaries (config/env, optional cloud/remote payloads).  
- Use inline guards/type predicates in parser hot paths and small internal envelopes.

**Recommended MVP Decision**
- Adopt hybrid.
- Keep `zod` for config/env validation only in Phase 1.
- Do not use `zod` in Claude/Codex parser loops.
- Add a single `validation/` module so guard logic is centralized, not scattered.

If you want, I can add this as a short “Validation Strategy” section in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md` and mirror it in `dev-docs/notes/dev.decision-log.md`.

# User_2026-02-22_1054_00

Yes, please add the validation strategy and the "integrate now" stuff. For IPC distinction, Unix domain sockets might not work in Windows? What does IPC stand for?

# gpt-5.3-codex_2026-02-22_1054_19

I’ll update the migration sequencing note with two additions: a concrete “Integrate Now” section from the Claude audit and a “Validation Strategy” section framed as we discussed. I’ll also answer the IPC question directly, including Windows portability notes for Unix domain sockets.

# gpt-5.3-codex_2026-02-22_1054_50

Added both requested sections to `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md`:

- `Integrate Now (from Claude Analysis)` at `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:40`
- `Validation Strategy (Framed Decision)` at `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:61`

Also added an explicit `IPC Distinction (MVP)` section at `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:93`, including your `decodeProjectDir` direction to leave it behind (`...:49`).

`IPC` stands for **Inter-Process Communication**.

On Unix domain sockets and Windows: yes, portability is a real concern. Even where supported, behavior/tooling differs enough that they’re a weak cross-platform MVP baseline. The note now treats them as post-MVP and points to file-based control/status first, with named pipes as the Windows-first option later.

# User_2026-02-22_1059_31

Great. What next?

# gpt-5.3-codex_2026-02-22_1059_52

Next high-impact tranche is to move from CLI scaffolding to real control flow.

1. Implement daemon control-plane file contract (MVP IPC)
- Add atomic `status.json` + `control` request file handling in `apps/daemon/src/orchestrator`.
- Make `kato status` read real status snapshots (not scaffold placeholders).

2. Implement command + path policy gate
- Port detector logic with fenced-code-block skip.
- Add canonicalize/allowlist checks before any write.
- Emit `policy.decision` audit events for allow/deny.

3. Implement writer pipeline
- Port exporter behavior including dedupe tail guard.
- Add destination writer rotation rules (`::record`/`::capture`) with policy check before rotate.

4. Wire validation strategy
- `zod` at config/env boundaries.
- Inline guards in parser/hot paths.
- Fail-closed on invalid config/state.

5. Then add Gemini provider spike
- Use provider-defined cursor semantics (index-based, not byte-offset-only) per your note.

If you want, I’ll start now with step 1 (status/control file + orchestrator stub + tests).

# User_2026-02-22_1104_07

Great. FYI, I added Claude's gemini info into a new task: [task.2026.2026-02-22-gemini-provider.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-gemini-provider.md)

# gpt-5.3-codex_2026-02-22_1104_15

Noted. I’ll use `dev-docs/notes/task.2026.2026-02-22-gemini-provider.md` as the source of truth for the Gemini provider tranche and keep it sequenced after control-plane/policy/writer basics from `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md`.

If you want, I can review that Gemini task next and normalize it into concrete implementation steps/acceptance criteria.

# User_2026-02-22_1105_02

That's okay on Gemini, unless you have burning thoughts you need to get in there now. Please proceed with Step 1.

# gpt-5.3-codex_2026-02-22_1105_14

Proceeding with Step 1 now: I’ll add a minimal orchestrator control-plane using atomic `status.json` plus a `control` request queue file, then wire `kato status` to read that real snapshot instead of scaffold state. I’m inspecting the current daemon/CLI code first so the integration is clean.

# User_2026-02-22_1108_59

Should we add `[ ]`-style items in [task.2026.2026-02-22-migration-and-mvp-sequencing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md) so we can keep track of what's done and what's left?

# gpt-5.3-codex_2026-02-22_1109_06

Yes, that’s the right move. I’ll add a compact checklist section to `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md` with `done / in-progress / next` items so we can track Step 1 and upcoming phases cleanly while I finish this implementation pass.

# gpt-5.3-codex_2026-02-22_1114_09

Yes, and I already added it.

- Checklist section added in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:29`.
- Step 1 is now marked complete in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:34`.

Step 1 implementation is also in place:

- New control-plane stores (atomic `status.json` + control request queue file): `apps/daemon/src/orchestrator/control_plane.ts:1`
- Orchestrator exports: `apps/daemon/src/orchestrator/mod.ts:1`
- CLI runtime wired to status/control paths and stores: `apps/daemon/src/cli/router.ts:27`
- `status` now reads real snapshots: `apps/daemon/src/cli/commands/status.ts:8`
- `start`/`stop`/`export`/`clean` now enqueue control requests:  
  `apps/daemon/src/cli/commands/start.ts:6`  
  `apps/daemon/src/cli/commands/stop.ts:6`  
  `apps/daemon/src/cli/commands/export.ts:8`  
  `apps/daemon/src/cli/commands/clean.ts:14`
- Legacy scaffold state store removed: `apps/daemon/src/cli/state_store.ts`
- Tests updated/added: `tests/daemon-cli_test.ts:1`, `tests/daemon-control-plane_test.ts:1`
- Test task updated for file-backed tests: `deno.json:12`

Validation status:

- `deno task test` passed (36/36).
- `deno task ci` passed (fmt/lint/check/test all green).

1. Next highest-value move is Step 2: implement the fail-closed command/path policy gate and wire policy decision audit events.

# User_2026-02-22_1118_08

OK, proceed to step 2

# gpt-5.3-codex_2026-02-22_1118_17

Proceeding with Step 2 now. I’ll inspect the current command parsing and write-path handling in `apps/daemon` and then add a fail-closed path-policy gate with tests, including fenced-code-block command suppression.

# gpt-5.3-codex_2026-02-22_1124_06

Step 2 is complete.

- Added strict in-chat command detection with fenced-code suppression and fail-closed errors in `apps/daemon/src/policy/command_detection.ts:1`.
- Added canonical write-path policy gate (allowlist roots + traversal/symlink escape denial) in `apps/daemon/src/policy/path_policy.ts:1`.
- Wired policy gate into CLI runtime/options in `apps/daemon/src/cli/router.ts:32` and command context in `apps/daemon/src/cli/commands/context.ts:9`.
- Enforced policy before queuing `export`, with `policy.decision` audit events and hard deny on failure in `apps/daemon/src/cli/commands/export.ts:8`.
- Exported policy APIs from `apps/daemon/src/policy/mod.ts:1` and `apps/daemon/src/mod.ts:32`.
- Added tests:
  - Command detection: `tests/command-detection_test.ts:1`
  - Path policy: `tests/path-policy_test.ts:1`
  - CLI deny-path behavior: `tests/daemon-cli_test.ts:259`
- Marked Step 2 complete in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:35`.

Validation:
- `deno task test` passed.
- `deno task ci` passed.

Policy config defaults now:
- `KATO_ALLOWED_WRITE_ROOTS_JSON` (JSON string array) if set.
- Else `KATO_ALLOWED_WRITE_ROOT`.
- Else fallback root `"."` (repo cwd).

1. Next up is Step 3: writer pipeline + destination rotation + dedupe append guard.

# User_2026-02-22_1142_04

I asked Claude to review your work in [conv.2026.2026-02-22-claude-supervision.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-22-claude-supervision.md) -- please review that and let's discuss.

# gpt-5.3-codex_2026-02-22_1142_04

I’ve verified Claude’s points against current code. I’ll give you a tight “agree/adjust” readout and then propose the exact decisions we should lock before Step 3.

# gpt-5.3-codex_2026-02-22_1142_28

Claude’s review is strong, and I mostly agree.

**Already Resolved**
- `policy.decision` audit events are already emitted on export path checks in `apps/daemon/src/cli/commands/export.ts:13`.
- Step 2 checklist is now marked complete in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:35`.

**I Agree We Should Discuss Now**
1. Daemon startup semantics are still undefined.  
`start` currently only enqueues a request in `apps/daemon/src/cli/commands/start.ts:6`.
2. Provider cursor contract should change before Gemini.  
`offset: number` is still in `shared/src/contracts/ipc.ts:5`.
3. Control queue consumption semantics are missing.  
Only append/list exists in `apps/daemon/src/orchestrator/control_plane.ts:297`.
4. Status liveness/staleness needs explicit handling.  
Status has no heartbeat/version in `shared/src/contracts/status.ts:12`.

**My Recommended Decisions**
1. Startup mode: make `kato start` run daemon in foreground for MVP (simplest, deterministic).  
Post-MVP: add background/detached launcher.
2. Control queue semantics: append-only queue + separate consumer cursor (`lastProcessedRequestId`), not consume-clear rewrites.
3. IPC cursor contract: replace `offset: number` with provider cursor type now (at least `string | number`, preferably tagged).
4. Status contract: add `schemaVersion` + `heartbeatAt`, and mark status stale when heartbeat age exceeds threshold.

If you want, I can implement these as a focused “Step 2.5 contract hardening” pass before Step 3.

# User_2026-02-22_1148_04

1. stenobot had background/detached launcher. Shouldn't be to hard to do something similar in Deno?

2. Is the queue in-memory-only? Don't we need something to contain growth?

3. yes

4. OK.

Yes, let's do a step 2.5 now please.

# gpt-5.3-codex_2026-02-22_1149_09

I’m implementing Step 2.5 in five pieces: contracts first, then queue hardening, then detached launcher/runtime loop, then CLI behavior, then full validation and note updates. I’ve started with the shared contract updates.

# gpt-5.3-codex_2026-02-22_1154_51

Reviewed and agreed. I implemented Step 2.5 now.

On your 4 points:

1. Detached launcher: implemented.
- `kato start` now launches a detached background daemon process via `Deno.Command` in `apps/daemon/src/orchestrator/launcher.ts:12`.
- Internal daemon mode is wired through `__daemon-run` in `apps/daemon/src/main.ts:17`.
- CLI wiring for launcher injection/default is in `apps/daemon/src/cli/router.ts:91`.
- `start` now launches instead of queueing a start request in `apps/daemon/src/cli/commands/start.ts:18`.

2. Queue growth: handled.
- Queue is file-backed (`control.json`), not memory-only.
- Added `markProcessed()` compaction and `lastProcessedRequestId` in `apps/daemon/src/orchestrator/control_plane.ts:24`.
- Added hard queue cap (`MAX_CONTROL_QUEUE_LENGTH`) in `apps/daemon/src/orchestrator/control_plane.ts:9`.
- Invalid control queue now fails closed (throws) instead of silently resetting in `apps/daemon/src/orchestrator/control_plane.ts:329`.

3. Provider cursor: done.
- Replaced `offset: number` with tagged provider cursor in `shared/src/contracts/ipc.ts:1`.

4. Status schema + liveness: done.
- Added `schemaVersion` and `heartbeatAt` to status contract in `shared/src/contracts/status.ts:12`.
- Added stale detection helper in `apps/daemon/src/orchestrator/control_plane.ts:228`.
- `status` now reports schema/heartbeat and stale state in `apps/daemon/src/cli/commands/status.ts:37`.
- `stop` handles stale-running status without enqueueing unbounded stop requests in `apps/daemon/src/cli/commands/stop.ts:15`.

Also added minimal daemon runtime loop:
- `apps/daemon/src/orchestrator/daemon_runtime.ts:55`
- It heartbeats status, consumes control requests, compacts queue via `markProcessed`, and exits on `stop`.

Tests/validation:
- Added/updated tests in:
  - `tests/daemon-runtime_test.ts:1`
  - `tests/daemon-control-plane_test.ts:24`
  - `tests/daemon-cli_test.ts:194`
- `deno task test` and `deno task ci` both pass (47 tests total).

Task note updated:
- Step 2.5 recorded as complete in `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:36`.

1. If you want, next I’ll move directly into Step 3 (writer pipeline + destination rotation + dedupe guard).