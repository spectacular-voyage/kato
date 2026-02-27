---
id: 6evxuvfax22pugp8uqwwpvn
title: 2026 02 27 Inchat Command Redesign
desc: ''
updated: 1772198609333
created: 1772198606696
---

# In-Chat Recording Command Redesign (Primary Destination Model)

## Summary
Replace overloaded `::record` semantics with a single-primary, no-UI model that is explicit about session state versus recording state.

1. Session owns a single `primaryRecordingDestination` pointer.
2. Session maintains one stable `recordingId` per destination path.
3. Recording runtime state is either active or inactive for that session.
4. Add `::init [abs-path]` to set/prepare destination without starting.
5. Make `::record` argument-less and define it as start/resume at session primary destination.
6. Keep `::capture [abs-path]` as snapshot + activate, and make it set session primary destination.
7. Simplify `::stop` to argument-less only.
8. Keep global default fallback if session primary destination is unset.
9. Apply hard switch now, no compatibility aliases (`::start`, `::record <path>`, `::stop <arg>`).

## Goals
1. Remove ambiguity: after `::stop`, `::record` always resumes the session primary destination.
2. Preserve deterministic behavior in no-UI contexts.
3. Keep absolute-path-only policy for explicit path arguments.
4. Ensure outcomes remain inspectable in logs without UI feedback.
5. Support in-message command sequencing with command-level recording boundaries.
6. Make destination identity allocation idempotent: one `recordingId` per path.

## Command Contract
1. Valid commands:
- `::init`: resolve destination as `primaryRecordingDestination` if set, otherwise global default; validate, prepare file if missing, ensure destination `recordingId`, do not start recording.
- `::init <abs-path>`: validate and prepare destination, set `primaryRecordingDestination`, ensure destination `recordingId`, do not start recording.
- `::record`: start/resume recording at `primaryRecordingDestination` if set, otherwise global default; ensure destination `recordingId` exists and reuse it.
- `::capture`: snapshot full conversation up to this command boundary into primary destination (or global default if unset), set pointer to resolved destination, ensure/reuse destination `recordingId`, activate recording there.
- `::capture <abs-path>`: snapshot full conversation up to this command boundary into path, set pointer to path, ensure/reuse destination `recordingId`, activate recording there.
- `::stop`: stop active recording only; preserve pointer.
- `::export <abs-path>`: export full conversation up to this command boundary; do not modify pointer or recording active state.
2. Invalid commands (parse error):
- `::start`
- `::record <anything>`
- `::stop <anything>`
3. Path argument policy:
- All explicit path arguments must be absolute.
- Relative paths, `@mentions`, and relative markdown-link targets are rejected.
4. Fallback policy:
- If pointer is unset and command needs destination, use global default root (`~/.kato/recordings/...`).

## Explicit State Machine
State is split into session state and recording state.

1. Session state:
- `primaryRecordingDestination`: `unset | set(absPath)`
- `recordingIdByDestination`: map of canonical absolute destination to stable `recordingId`
2. Recording state:
- `activeRecording`: `off | on(absPath)`

Allowed composite states:
1. `S0`: pointer unset, active off.
2. `S1(P)`: pointer set to `P`, active off.
3. `S2(P)`: pointer set to `P`, active on `P`.

Transition rules:
1. `::init` with resolved destination `P`:
- `S0 -> S1(P)`
- `S1(Pold) -> S1(P)`
- `S2(Pold) -> error` (must `::stop` first; no implicit rotate during active recording).
- `ensureRecordingId(P)` is idempotent (allocate only if missing).
2. `::record`:
- `S0 -> S2(G)` where `G` is generated global default and also persisted as pointer.
- `S1(P) -> S2(P)`
- `S2(P) -> S2(P)` no-op.
- `ensureRecordingId(activeDestination)` before activation.
3. `::capture` with resolved destination `D`:
- `S0 -> S2(D)` and pointer set `D`.
- `S1(P) -> S2(D)` and pointer set `D`.
- `S2(P) -> S2(D)` and pointer set `D` (capture rotates active destination).
- `ensureRecordingId(D)` is idempotent (reuse when already allocated).
4. `::stop`:
- `S2(P) -> S1(P)`
- `S0`, `S1(P)` remain unchanged (no-op).
5. `::export`:
- `S0`, `S1(P)`, `S2(P)` unchanged.

## Init Destination Preparation
`::init [abs-path]` should prepare the target so users can infer success without UI.

1. Resolve destination:
- If `<abs-path>` is provided, use it.
- Else if `primaryRecordingDestination` exists, use it.
- Else use generated global default destination.
2. Validate resolved destination and policy gate before mutation.
3. Ensure stable destination identity:
- If destination has no `recordingId`, allocate one as a pending value.
- If destination already has one, reuse it (no new allocation).
4. If file does not exist, create it.
5. For Markdown targets when frontmatter is enabled, write full frontmatter on create using command-time snapshot context:
- `title` from snapshot title resolver.
- `sessionId` from provider session metadata.
- `participants` and `conversationEventKinds` derived from snapshot events up to init boundary.
- `created`/`updated` timestamps from init execution time.
- `recordingIds` includes the stable destination `recordingId`.
6. For non-Markdown targets, create empty file.
7. If file already exists, leave content unchanged (idempotent no-op for content).
8. Persist `primaryRecordingDestination` only after file preparation succeeds:
- Missing file: pointer commit happens only if create succeeds.
- Existing file: pointer commit happens only after validation succeeds.
9. Commit pending/new destination `recordingId` only with the same successful pointer commit.

## In-Message Sequential Execution and Boundaries
Commands inside one `message.user` are processed in source order using parsed line numbers.

1. Parse command lines with stable order.
2. Execute commands sequentially in that order.
3. Define per-command boundary slices:
- Snapshot boundary for `capture` and `export`: all conversation up to and including command boundary.
- Start boundary for `record` in inactive state: do not include content before the `::record` line.
4. `record` in inactive state with trailing text in same message:
- Seed append only the text between this command line and the next command line (or message end).
- This gives in-message granularity without recording earlier lines from same message.
5. If `record` is no-op in `S2`, it does not reseed any same-message content.

## Failure and Atomicity Rules
1. `init` failure leaves pointer unchanged.
2. `init` failure leaves destination identity map unchanged.
3. `record` failure leaves pointer unchanged.
4. `capture` failure leaves pointer and active state unchanged.
5. `capture` failure leaves destination identity map unchanged if allocation/write fails before commit.
6. `export` failure leaves pointer and active state unchanged.
7. Sequential execution is not transactional across commands in one message:
- Earlier successful commands persist even if a later command fails.

## Implementation Plan
1. Update parser in [command_detection.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/policy/command_detection.ts):
- Add `init` command support.
- Remove `start` support.
- Enforce `record` has no argument.
- Enforce `stop` has no argument.
- Keep `capture` optional argument.
- Keep `export` required argument.
2. Refactor command execution in [daemon_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/daemon_runtime.ts):
- Remove `record -> start` alias.
- Add `init` command branch with prepare-file behavior.
- Add explicit composite-state transition handling (`S0`, `S1`, `S2`).
- Add no-op path for `record` in active state.
- Add command-boundary slicing for same-message execution.
3. Add runtime helpers:
- `resolvePrimaryDestination(...)` to return pointer or generated global default.
- `setPrimaryDestination(...)` and pointer normalization.
- `ensureDestinationRecordingId(...)` to allocate/reuse stable per-path ID.
- `prepareInitDestination(...)` to create file/stub safely.
- `resolveCommandBoundaries(...)` and segment extraction for same-message granularity.
4. Extend metadata contract in [session_state.ts](/home/djradon/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts):
- Add `primaryRecordingDestination?: string`.
- Add `recordingIdByDestination?: Record<string, string>` (canonical path key -> stable recordingId).
5. Persist pointer in [session_state_store.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/session_state_store.ts):
- Clone/read/write support for new fields.
6. Keep path policy gate unchanged in [path_policy.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/policy/path_policy.ts):
- Still gate absolute canonical destination against allowed roots.
7. Update docs:
- Update command semantics in [README.md](/home/djradon/hub/spectacular-voyage/kato/README.md).
- Update workspace note linkage to current note files and remove stale filename references.

## Tests and Scenarios
1. Update parser tests in [command-detection_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/command-detection_test.ts):
- `::init /abs/a.md` parses.
- `::init` parses.
- `::record` parses.
- `::stop` parses.
- `::start` fails.
- `::record /abs/a.md` fails.
- `::stop id:abc` fails.
2. Update runtime tests in [daemon-runtime_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-runtime_test.ts):
- `::record` in `S0` generates default destination, persists pointer, starts active.
- `::init /abs/a.md` in inactive state sets pointer and prepares file, active unchanged.
- `::init` in `S0` creates default destination file, sets pointer, and allocates destination ID.
- `::init` with existing pointer and existing file is content no-op.
- `::init` in active state fails.
- Failed `init` leaves pointer unchanged.
- Failed `record` leaves pointer unchanged.
- `::record` in `S1` starts active at pointer.
- `::record` in `S2` is no-op.
- `::stop` in `S2` stops but preserves pointer.
- `::record` after stop resumes pointer destination.
- `::capture /abs/b.md` captures, sets pointer to `/abs/b.md`, and activates there.
- `::capture` no arg captures to pointer if set, otherwise generated default, and activates there.
- Repeated `::init`/`::capture` to same destination reuses the same destination `recordingId`.
- Two different destinations allocate two distinct `recordingId` values.
- Frontmatter on file creation includes the stable destination `recordingId`.
- `::export /abs/e.md` exports snapshot boundary only; pointer and active unchanged.
- Sequential one-message commands execute in order (`::stop`, `::init`, `::record`).
- In-message `::record` granularity excludes lines before command boundary.
- Relative arg rejection for `init`, `capture`, and `export`.
3. Replace obsolete tests:
- Remove/replace tests that depend on ambiguous `::stop` target matching.
- Remove/replace tests that depend on `::start` command.
- Remove/replace tests that depend on pathful `::record`.
4. Logging assertions:
- Parse errors logged via `recording.command.parse_error`.
- Runtime invalid-target logs include explicit absolute-path reason.
- No-op and state-transition events are logged with deterministic metadata.

## Rollout, Risk, and Compatibility
1. Hard switch in one release.
2. No backward-compat aliases for old in-chat command forms.
3. Primary risk: existing user muscle memory for `::start` and `::record <path>`, plus implicit `::stop <arg>` selectors.
4. Mitigation:
- README command table and examples updated.
- Clear parse error messages indicating replacement forms (`::init [abs-path]`, then `::record`).

## Assumptions and Defaults
1. No active sessions currently depend on multi-active recording behavior.
2. No persisted metadata migration is required for multi-active cleanup.
3. Primary destination pointer is session-scoped and persisted.
4. Global fallback root remains `~/.kato/recordings` (or `.kato/recordings` when home cannot be resolved).
5. Destination identity is canonical-path-scoped and persisted as one `recordingId` per path.
