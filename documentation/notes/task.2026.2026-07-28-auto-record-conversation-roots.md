---
id: task-2026-07-28-auto-record-conversation-roots
title: Auto-Record Conversation Roots
desc: Make workspace auto-recording match real Claude working directories via explicit conversation roots, and stop failing silently.
updated: 1785266853000
created: 1785265932657
---

## Goal

Make `autoRecordConversations` fire for real Claude conversations by letting a workspace declare which conversation working directories it records, and make auto-record failures visible instead of audit-log-only.

## Summary

Auto-record works as contracted — a session whose `cwd` is at or below the workspace root attaches (proven by `tests/daemon-runtime_test.ts:831`) — but the contract does not fit observed workspace layouts. In practice a Kato workspace root is a notes/output vault nested inside a project repo (e.g. `.../stagecraft/dependencies/.../stagecraft-conv/notes`), while conversations run at the repo root (e.g. `.../stagecraft`): the conversation directory contains the workspace root, not the reverse, so `isPathWithinRoot(workingDirectory, profile.workspaceRoot)` (`apps/daemon/src/orchestrator/daemon_runtime.ts:674`) never matches for these setups.

Evidence from this machine's daemon audit log (2026-07-12): every `recording.auto_record.*` event is `recording.auto_record.failed` (131 of them, zero `activated`), with `workingDirectory` values that are repo roots like `/home/djradon/hub/spectacular-voyage/stagecraft`. Those particular failures were config errors from a transitional hand-edit (`autoRecordConversations` under `workspaceFeatureFlags`, then invalid YAML) — demonstrating the second problem: config-resolution failures fail closed and are re-logged once per session per poll tick in a log file nobody watches, with nothing surfaced in Kato Web. Third: nothing records when the daemon is not running, and no surface distinguishes armed-but-idle from broken.

## Discussion

The fix must be an explicit contract, not magic. Options considered for matching conversations to a workspace:

1. Invert/loosen containment automatically (match when the workspace root is inside the conversation cwd, or walk up to a git root). Rejected: implicit, surprising, wrong for monorepos with several workspaces under one repo.
2. Explicit `autoRecordRoots: string[]` on the workspace config: a session is eligible when its `cwd` is within any listed root. Chosen: declarative, testable, no inference.

When `autoRecordRoots` is absent or empty, current behavior (match against the workspace root) is preserved, so the key is purely additive for existing configs. Matching stays purely lexical (`isPathWithinRoot` uses `resolve`/`relative` and never stats): roots need not exist on disk, and a stale `cwd` string under a configured root would match — accepted and documented, no existence checks.

Multiple matches: the existing loop already attaches every matching workspace (`daemon_runtime.ts:685` does not break after a match). Explicit roots make overlap more likely; behavior stays "all matching workspaces attach" for consistency, with duplicate and nested root entries deduplicated at resolution time (exact duplicates removed; nested entries kept — they are harmless under containment matching).

Failure visibility has two distinct failure classes inside today's single `try/catch` (`daemon_runtime.ts:687-793`):

- Workspace-scoped config/profile-resolution failures: independent of any session. These move out of the per-session loop — profiles resolve once per poll pass, before iterating snapshots — and are logged once per workspace per distinct error message (re-logged when the message changes, cleared on successful resolution).
- Session-scoped activation failures (destination resolution, path policy, attachment): these keep per-session context and per-session logging as today.

The resolved-workspace pass model: `processPersistentRecordingUpdates` resolves the auto-record workspace list once per tick (workspaces with `autoRecordConversations: true` plus their resolved roots, or their resolution error) and passes it to `applyWorkspaceAutoRecording` per snapshot. When no snapshots exist, resolution still runs and still publishes/clears failure state, so a broken config is visible without traffic.

Status publishing: daemon status JSON has no workspace collection today (`shared/src/contracts/status.ts`). This task adds one, additively (no schema version bump): per auto-record-enabled (or resolution-failed) workspace, `{workspaceId, alias, enabled, roots: string[], lastActivation?: {sessionId, at}, lastFailure?: {scope: "config" | "activation", message, sessionId?, at}}`. State is in-memory daemon state: `lastFailure` clears when the same scope succeeds (config resolves / a later activation succeeds); nothing survives restart. Web semantics for a stopped daemon or stale heartbeat stay whatever the existing status-freshness handling does — the workspace entries are simply absent or stale, and the web read surface ([[task.2026.2026-07-28-workspaces-read-view-auto-record]]) must render that as unknown, never as "off".

Config semantics: raw config and web edit preserve entry strings verbatim (`~`, relative); only resolved profiles expose absolute paths. Resolution: absolute as-is; `~`/`~/...` via existing `expandHomePath` (`~user` is not expanded — it stays literal and, being lexical, will effectively never match; documented); relative entries against the workspace root; normalized before matching. Entry order is preserved (order has no matching significance). Validation fail-closed: non-list, non-string, or empty/whitespace entries reject the config. Downgrade: older binaries reject unknown top-level keys (`registry.ts:650`), so a config using `autoRecordRoots` fails closed on older Kato — release notes must say so.

Coupling with [[task.2026.2026-07-12-auto-record-subconversation-scope]]: both tasks touch registry key allowlist/serialization, scaffold, shared-template materialization, web edit, and the auto-record eligibility path. They remain separate tasks (this one gates where sessions match; that one gates which sessions are eligible), but implementation must be explicitly sequenced: whichever lands second rebases its config-surface changes on the first; the shared-template materialization work specified there is not duplicated here. If both are in flight simultaneously, land the registry/config surface as one combined change.

Existing-output behavior stays: a session that already has any output for the workspace (even stopped) is never re-armed automatically — deliberate "don't fight the operator" stance, now recorded as a decision.

## Open Issues

- Should there be a global "record everything to a default workspace" mode? Out of scope; belongs in [[product-ideas]] if wanted.

## Decisions

- Add top-level workspace config key `autoRecordRoots: string[]`; a Claude session matches when its `cwd` is lexically within any resolved root.
- Absent/empty `autoRecordRoots` falls back to matching the workspace root (purely additive).
- Pure lexical matching; no existence checks; `~user` unexpanded; relative entries resolve against the workspace root; exact-duplicate entries deduplicated.
- All matching workspaces attach (unchanged multi-match behavior).
- Resolve auto-record workspace profiles once per poll pass, outside the per-snapshot loop; resolution runs even with zero snapshots.
- Deduplicate workspace-scoped config-failure logging per workspace per distinct error; clear on recovery. Session-scoped activation failures keep per-session logging.
- Publish per-workspace auto-record state into daemon status JSON additively with the shape given in Discussion; in-memory lifecycle, cleared per scope on recovery, absent after restart until re-resolved.
- Keep "any prior output for the workspace blocks re-arming".
- Keep auto-record Claude-only and persistent-mode-only in this slice; the status surface is what makes the latter visible.
- Sequence config-surface changes explicitly with the subconversation-scope task; no duplicated shared-template materialization work.

## Contract Changes

- `.kato-workspace-config.yaml` accepts top-level `autoRecordRoots: string[]`; parse/validate/canonical-serialize in `apps/runtime/src/workspace/registry.ts`; scaffold includes `autoRecordRoots: []`; mutations and web edit support it, preserving raw entry strings.
- Resolved workspace profiles expose resolved absolute `autoRecordRoots`.
- `processPersistentRecordingUpdates`/`applyWorkspaceAutoRecording` restructured to the per-pass resolution model with split failure classes.
- Daemon status JSON gains the additive per-workspace auto-record collection.

## Scenario Table

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| No `autoRecordRoots`, cwd inside workspace root | Yes | N/A | N/A | Auto-records (unchanged fallback). |
| No `autoRecordRoots`, cwd is repo root containing the workspace | Yes | N/A | N/A | Not recorded (unchanged); the new key is the remedy. |
| `autoRecordRoots: [<repo root>]`, cwd at or below repo root | Yes | N/A | N/A | Auto-records. |
| `autoRecordRoots: [<repo root>]`, cwd in unrelated project | Yes | N/A | N/A | Not recorded. |
| Relative / `~` root entries | Yes | N/A | N/A | Resolved against workspace root / home, then matched lexically. |
| Nonexistent root entry with matching stale cwd string | Yes | N/A | N/A | Matches (lexical contract); documented. |
| Invalid entry type (non-string/empty) | Yes | N/A | N/A | Config fails closed; workspace-scoped failure logged once and published to status. |
| Broken workspace config while others are healthy | Yes | N/A | N/A | Broken workspace logged once per distinct error; healthy workspaces unaffected. |
| Config repaired after failure | Yes | N/A | N/A | Failure state clears; next matching session attaches; recovery visible in status. |
| Overlapping roots across workspaces | Yes | N/A | N/A | All matching workspaces attach. |
| Session already has stopped output for the workspace | Yes | N/A | Yes | Never re-armed automatically. |
| Codex/Gemini session | Yes | N/A | Yes | Still excluded in this slice. |
| Daemon in non-persistent mode | N/A | Yes | Yes | Auto-record remains persistent-mode-only; absent status entries make that visible rather than silent. |

## Testing

- Config: parse/validate/serialize `autoRecordRoots` (absolute, `~`, `~user` literal, relative, `..` segments, invalid entries fail closed, duplicates deduped, order preserved), scaffold output, mutation round trip, web edit round trip preserving raw strings, missing-`HOME` behavior.
- Matching: cwd within/at/outside roots; fallback-to-workspace-root when absent; nested and duplicate roots; lexical symlink behavior pinned by test; Windows path semantics (drive case, separators) at least via the existing `isPathWithinRoot` test surface.
- Pass model: profiles resolved once per tick (spy/count), zero-snapshot tick still publishes/clears config failures, multiple sessions in one tick share one resolution.
- Failure handling: workspace-scoped failure logged once per distinct error, re-logged on message change, cleared on recovery; identical error repeating after recovery logs again; session-scoped activation failures keep session context; healthy workspaces process despite a broken one.
- Status: activation and failure state visible; entries absent after restart until next resolution; disabled workspaces absent; alias/roots populated.
- Regression: existing auto-record suites in `tests/daemon-runtime_test.ts` pass; existing-output-blocks-re-arm; disabled-to-enabled transition attaches on next tick.
- Run focused runtime/config/web tests and `deno task ci`.

## Non-Goals

- No codex/gemini auto-recording.
- No git-root or other implicit inference of conversation roots.
- No existence/stat checks in matching.
- No auto-stopping or mutating existing outputs; no re-arming sessions with prior outputs.
- No global/default-workspace catch-all recording.
- No persistence of auto-record health across daemon restarts.
- No web rendering changes (owned by [[task.2026.2026-07-28-workspaces-read-view-auto-record]]).

## Implementation Plan

- [x] Add the `autoRecordRoots` config contract: parsing, validation, canonical order, scaffold, resolver projection (raw preserved, resolved absolute), mutation, web edit field — coordinated with the subconversation-scope task's config-surface changes.
- [x] Restructure persistent-tick auto-record to the per-pass resolution model with split workspace-scoped vs session-scoped failure handling and dedup/recovery logging.
- [x] Match against resolved roots with workspace-root fallback.
- [ ] Publish the additive per-workspace auto-record status collection (follow-up; read-view health display depends on it).
- [x] Tests: config parse/resolve/reject/scaffold, runtime roots-matching outside the workspace root, existing auto-record regression suite (927 passing).
- [ ] Remaining tests: failure-dedup/recovery logging, overlapping workspaces, missing-`HOME`, Windows path table.
- [x] Update [[user-guide.recording]], [[user-guide.workspaces]], and [[dev.decision-log]] (release notes at next `bump:version`).
- [ ] Run `deno task ci` before PR.
