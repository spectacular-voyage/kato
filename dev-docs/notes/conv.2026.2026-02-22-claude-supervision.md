---
id: rs08knolwvv20dt5mzol1t4
title: 2026 02 22 Claude Supervision
desc: ''
updated: 1771788010736
created: 1771788010736
---

# User_2026-02-22_1121_36

Codex is working on @dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md . Can you review progress so far, review the commits we've made, and point out any mistakes, missed opportunities, or things we should've discussed first?

# claude-sonnet-4.6_2026-02-22_1121_39

Let me read a few more key files to complete the picture.

Good picture now. Here's my review.

---

## Progress Review

### What's solid

- **CLI layer** is well-structured: strict fail-closed parsing, injected store interfaces make tests clean without touching the filesystem, consistent exit codes (0/1/2).
- **Atomic writes** (`status.json` via `tmp` + rename) are correctly implemented.
- **Fenced code block suppression** in `command_detection.ts` — this was an explicit "integrate now" from the Claude analysis and it's correctly done.
- **Inline guards** in `control_plane.ts` instead of zod — matches the hybrid validation decision for internal paths.
- **Parsers** (Claude + Codex) with byte-offset generators and tool-result linking are solid. Test fixtures are a good pattern.
- **Test harness design** (injected in-memory stores) is the right call for unit testing CLI command paths.

---

### Bugs / Concrete Issues

**1. `ProviderMessageEnvelope.offset: number` — will break Gemini**

[shared/src/contracts/ipc.ts:6](shared/src/contracts/ipc.ts#L6) has `offset: number`. The task note explicitly says (under "Integrate Now"):
> Treat provider checkpoints as provider-defined cursors, not byte offsets only (supports non-JSONL providers)

Gemini uses a JSON array index model. A raw `number` will technically still work, but it's semantically wrong and conflates two different cursor types. This should be `cursor: number | string` or a tagged cursor type before Gemini work starts — otherwise the IPC contract will need a breaking change later.

**2. No `schemaVersion` in `DaemonStatusSnapshot`**

`control.json` has `schemaVersion: 1` ([control_plane.ts:7](apps/daemon/src/orchestrator/control_plane.ts#L7)). `status.json` has no version field at all ([status.ts](shared/src/contracts/status.ts)). If the status schema changes, there's no detection path. Minor inconsistency that will bite later.

**3. Control request queue has no dequeue/consume/expiry**

[control_plane.ts:302-315](apps/daemon/src/orchestrator/control_plane.ts#L302) — `enqueue` appends to `requests[]`. Nothing ever removes entries. `control.json` grows unboundedly. This isn't a bug yet (the orchestrator isn't consuming anything), but the consumption semantics were never discussed. Before the orchestrator reads from this file, you'll need to decide: does it consume-and-clear, mark processed, or use a different handoff mechanism?

---

### Design Decisions That Should Have Been Discussed First

**4. How does `kato start` actually launch the daemon?**

[commands/start.ts](apps/daemon/src/cli/commands/start.ts) enqueues a control request. But there's no `Deno.Command` spawn or subprocess invocation anywhere. In `stenobot`, `start.impl.ts` spawned a background process. For Kato, the mechanism is unspecified. Options include:
- CLI spawns `apps/daemon/src/main.ts` as a detached subprocess, then exits.
- CLI writes a control request and something already running processes it (but then what's "already running" if not the daemon?).
- `kato start` IS the daemon (foreground), and the CLI commands in the same binary are the control surface.

This is a fundamental architecture question. The current code suggests option 2 or 3 but doesn't commit. This should be settled before the writer pipeline (Step 3) because the answer determines whether `start.ts` needs a `Deno.Command` call.

**5. Status staleness and daemon liveness**

If the daemon exits without updating `status.json`, `daemonRunning: true` persists forever. `kato status` would show a running daemon that isn't running. The PID field (`daemonPid`) could be used to cross-check, but there's no code doing that. How and when the daemon updates the status file on shutdown, crash, or heartbeat wasn't discussed.

---

### Checklist Accuracy

**Step 2 is largely done but marked `[ ]`**

[task.2026.2026-02-22-migration-and-mvp-sequencing.md:35](dev-docs/notes/task.2026.2026-02-22-migration-and-mvp-sequencing.md#L35) says Step 2 (command detection + fail-closed path-policy gate) is not started. But `command_detection.ts` and `path_policy.ts` both exist and are tested. The only genuinely missing pieces from Step 2 are:
- Emitting `policy.decision` audit events through `AuditLogger` when the gate fires.
- Wiring command detection to the actual message ingestion pipeline (no orchestrator/ingest stage exists yet).

The checklist should reflect "partially done."

---

### Smaller Missed Opportunities

- **`dev.codebase-overview.md`** — `dev.general-guidance.md` requires continuous doc updates. Given the pace of commits, this is almost certainly stale now.
- **`shared/src/contracts/config.ts`** is a stub (only `RuntimeConfigMetadata` with schema version numbers). No actual config schema (allowed write roots, provider directories, etc.), no zod boundary validation. OpenFeature was also committed to from MVP start but has no code yet — both are Step 4, so not overdue, but worth tracking.
- **`DaemonStatusSnapshotFileStore.load()`** silently falls back to a default "not running" snapshot on invalid/corrupt JSON ([control_plane.ts:242-251](apps/daemon/src/orchestrator/control_plane.ts#L242)). The task doc says "fail-closed on invalid config/state" — this is debatable for a read-only status display, but the control request store does the same (silently resets to empty queue on corrupt `control.json`, which means queued requests can be silently dropped). That's the more concerning case.

---

### Summary Priority Order

| Priority | Item |
|---|---|
| Discuss now | How does `kato start` actually spawn/become the daemon? |
| Fix before Gemini | `ProviderMessageEnvelope.offset: number` → provider cursor type |
| Fix soon | Control request consumption/expiry semantics |
| Fix soon | Status staleness / liveness detection |
| Low | `schemaVersion` missing from `DaemonStatusSnapshot` |
| Housekeeping | Update `dev.codebase-overview.md`, mark Step 2 as partial |

# User_2026-02-22_1136_12

::capture @dev-docs/notes/conv.2026.2026-02-22-claude-supervision.md

# claude-sonnet-4.6_2026-02-22_1136_16

Ignoring that control command per [dev.general-guidance.md](dev-docs/notes/dev.general-guidance.md#L87).

Is there anything from the review you'd like to dig into or act on? The daemon startup mechanism question (#4) seems like the most important thing to settle before proceeding to Step 3.

# User_2026-02-22_1137_28

::capture /home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-22-claude-supervision.md

# claude-sonnet-4.6_2026-02-22_1137_32

Ignoring control command per [dev.general-guidance.md](dev-docs/notes/dev.general-guidance.md#L87).

Looks like Codex just completed Step 2 — `command_detection.ts` and `path_policy.ts` are now confirmed as its work (not pre-existing). That resolves the checklist accuracy issue I raised. My review items still stand, particularly the daemon startup mechanism question before Step 3 begins. Want to discuss that now?

# User_2026-02-22_1159_43

Codex added your suggestions as step 2.5, now complete. Are we ready for Step 3?

# claude-sonnet-4.6_2026-02-22_1200_16

Good progress — Step 2.5 resolved all four items I flagged. Let me check the remaining unknowns before endorsing Step 3.

# claude-sonnet-4.6_2026-02-22_1201_14

Step 2.5 resolved all the issues I flagged. The contract hardening is solid. But there are 3 things that will cause writer rework if not decided first.

---

## Ready for Step 3? — Mostly Yes, With 3 Pre-decisions

### What's been fixed correctly

- `ProviderCursor` tagged union (`byte-offset` | `item-index` | `opaque`) — clean
- `schemaVersion` + `heartbeatAt` on status, `isStatusSnapshotStale()` — clean
- `markProcessed()` + `MAX_CONTROL_QUEUE_LENGTH` + fail-closed on corrupt control queue — clean
- Detached launcher + `__daemon-run` internal mode — clean
- `stop` handles stale-running status without enqueuing — clean

---

### One lingering issue to note

`DaemonStatusSnapshotFileStore.load()` at [control_plane.ts:280-290](apps/daemon/src/orchestrator/control_plane.ts#L280) still silently falls back to a default snapshot on invalid JSON (while the control queue now correctly throws). This is arguably acceptable for display purposes — you always want to show *something* — but it's inconsistent with "fail-closed." Not blocking Step 3, just worth knowing.

---

### Three things to decide before Codex starts Step 3

**1. Recording identity model**

`RecordingStatus` has `activeRecordings: number` and `destinations: number` counts, but no IDs. The `export` command takes a `sessionId` but the writer pipeline in `ipc.ts` uses a `recordingId`. How are recordings keyed? Options:

- **Provider session ID = recording ID** (1:1, simplest)
- **`::record` command starts a recording with a generated ID**, bound to a (sessionId, destinationPath) pair
- **Something else**

This determines how rotation works and how the orchestrator runtime will dispatch `export` requests.

**2. `::record` vs `::capture` behavioral contract in the writer**

From stenobot's exporter, the distinction is:
- `::record path` → open/maintain an ongoing stream writer to `path` (append as new messages arrive)
- `::capture path` → one-shot dump of all messages seen so far to `path`, then continue with existing record target

The writer needs to handle these differently. Should Kato preserve this distinction, or simplify it?

**3. Frontmatter ID format**

Stenobot uses `nanoid(10)` (compact, human-friendly, appears in user-facing `.md` files used by Dendron). Library substitutions say prefer `crypto.randomUUID()` unless compact IDs are explicitly required. Frontmatter IDs *are* a case where compact matters (36-char UUIDs are ugly in Dendron). Recommend: allow a small local `nanoid`-style utility (just alphanumeric random, no dependency needed), or explicitly accept UUIDs.

---

**Everything else in Step 3 can proceed with clear defaults:**
- Output format: Markdown (same as stenobot, no change)
- Dedupe tail guard: carry forward the `existingTrimmed.endsWith(content)` check from stenobot
- Date formatting: native `Intl` (already decided in library substitutions, replacing `date-fns-tz`)
- Speaker names / tool call / thinking config: defer to Step 4 (config/OpenFeature boundary)

Once you answer those three, Step 3 is unblocked.

# User_2026-02-22_1254_46

We added a step 2.6 for runtime config bootstrap. Could you review?

# claude-sonnet-4.6_2026-02-22_1255_18

Let me check a couple more things before reviewing.

# claude-sonnet-4.6_2026-02-22_1256_22

Step 2.6 is well-constructed overall. Here's the review.

---

## Step 2.6 Review

### What's solid

- `RuntimeConfig.allowedWriteRoots` is correctly wired to `WritePathPolicyGate` at [router.ts:210-213](apps/daemon/src/cli/router.ts#L210) — no more env-var double-read. The config is now the authoritative source post-load.
- `effectiveRuntime` at [router.ts:195-200](apps/daemon/src/cli/router.ts#L195) properly overrides runtime paths from loaded config, so config drives paths downstream.
- `kato init` / `ensureInitialized()` interface is clean. Idempotent with distinct output (`created` vs `already exists`).
- `start.ts` checking stale status before launching is correct — prevents double-starts.
- `schemaVersion: 1` as a literal type on `RuntimeConfig` is stricter than `DaemonStatusSnapshot.schemaVersion: number` — should align the latter.

---

### Issues

**1. Daemon subprocess doesn't receive configured paths — real gap**

`runDaemonRuntimeLoop()` ([daemon_runtime.ts](apps/daemon/src/orchestrator/daemon_runtime.ts)) still calls `resolveDefaultStatusPath()` / `resolveDefaultControlPath()` directly, which reads from env vars. The spawned `__daemon-run` process never receives the `statusPath` / `controlPath` from `RuntimeConfig`. For MVP with default paths this is invisible, but the moment a user runs `kato init` with a non-default `runtimeDir`, the daemon process will read/write the wrong files.

The launcher needs to pass the resolved config paths — either as env vars or CLI args to the `__daemon-run` subprocess.

**2. Silent fallback on missing config for non-`start`/non-`init` commands**

[router.ts:177-193](apps/daemon/src/cli/router.ts#L177): if `config.json` is not found and the command is `status`, `stop`, `export`, or `clean`, the code silently falls through to `defaultRuntimeConfig`. `kato status` will show "daemon not running" (plausible), but `kato export` or `kato clean` will silently operate against default paths the user may not intend. A `NotFound` on config for these commands should probably output something like "no runtime config found — run `kato init` first" and exit 1, rather than silently proceeding.

**3. Auto-init output on `kato start`**

The test asserts `"started in background"` but nothing asserts that auto-init is communicated to the user. If `kato start` silently creates config and then launches, the user has no feedback that init happened. Should print something like "initialized runtime config at .kato/runtime/config.json" before the start message.

**4. Optimistic status write race window (minor, known)**

[start.ts:18-26](apps/daemon/src/cli/commands/start.ts#L18): CLI writes `daemonRunning: true` + `launchedPid` before the daemon process has confirmed startup. If the daemon crashes immediately (bad permissions, port conflict, etc.), `status.json` shows a running daemon until the stale threshold (30s). Acceptable for MVP but worth noting in the task doc as a known limitation.

---

### Priority

| | |
|---|---|
| Fix before Step 3 | Daemon subprocess path propagation (gap #1) |
| Discuss | Silent fallback for `stop`/`export`/`clean` on missing config (gap #2) |
| Low | Auto-init print in `kato start` output (gap #3) |
| Note | Optimistic status race window (gap #4) |

The path propagation gap (#1) is the one most likely to cause silent misbehavior once anyone uses a non-default runtime dir.

# User_2026-02-22_1320_12

OK, I believe your suggestions were addressed, and step 3 has been implemented. Please review