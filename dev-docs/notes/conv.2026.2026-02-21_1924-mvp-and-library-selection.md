---
id: snokkxvsm6x7ql18t0vizjm
title: 2026 02 21_1924 Mvp and Library Selection
desc: ''
updated: 1771730707676
created: 1771730707676
---

# User_2026-02-22_0811_32

Let's Decide CLI + logging libraries first, with MVP-safe defaults and rationale recorded in the note: @mvp

::record [conv.2026.2026-02-21_1924-mvp-and-library-selection.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md)

# gpt-5.3-codex_2026-02-22_0811_32

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

# User_2026-02-22_0811_32

Let's also analyze the old code base under /stenobot and look for other opportunities to improve or simplify our approach. Nothing is off limits in terms of rearchitecture: given we have a new approach with other applications in the mix and other libraries to substitue.

# gpt-5.3-codex_2026-02-22_0811_32

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

# User_2026-02-22_0811_32

::capture [conv.2026.2026-02-21_1924-mvp-and-library-selection.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md)

# gpt-5.3-codex_2026-02-22_0811_52

I’ll treat this as a capture command and append the latest exchange into `dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md` using the same conversation-note format already in that file. I’m checking the file contents first so the entry is consistent.

# gpt-5.3-codex_2026-02-22_0812_04

Captured. The command and this response are now recorded in `dev-docs/notes/conv.2026.2026-02-21_1924-mvp-and-library-selection.md`.

# User_2026-02-22_0940_36

Have you read [dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md) ? You're supposed to ignore commands. (ie., I have stenobot running already).

Regarding open questions:

If "service mode" refers to running as Windows Service or System.d or whatever, let's completely defer that. I'm in WSL2 so don't even have a systemd-capable place to test. 

With OpenFeature, I think we might as well do that from the start?

# gpt-5.3-codex_2026-02-22_0940_36

I read it, and you’re right about the in-chat command handling rule. I’m updating the MVP task note now to close those two open questions with your decisions: service mode deferred and OpenFeature included from MVP start.

# gpt-5.3-codex_2026-02-22_0941_15

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

# User_2026-02-22_0952_36

I renamed the "mvp" task file to [task.2026.2026-02-22-migration-and-mvp-sequencing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md) You can add your "Highest-impact opportunities" and library substitutions there.

Regarding the rearchitecture,  you don't mention the CLI, which is used to control the daemon and do one-off stuff like status, export and clean.

# gpt-5.3-codex_2026-02-22_0952_36

I’m editing the sequencing note now: adding the `stenobot`-audit “Highest-impact opportunities,” adding library substitutions, and adding a rearchitecture section that explicitly defines the CLI as daemon control plus one-off command surface.

# gpt-5.3-codex_2026-02-22_0953_03

You’re right on both points.

I updated `dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md` to include:

- “Highest-Impact Opportunities” from the `stenobot` audit (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:29`)
- “Library Substitutions (MVP-Safe)” (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:40`)
- Explicit CLI role in rearchitecture (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:50`) including daemon control plus one-off commands (`status`, `export`, `clean`)

I also tightened sequencing so CLI wiring is a first-class step (`dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md:22`).

No tests were run (docs-only change).