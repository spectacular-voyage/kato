---
id: pskgvekxfoz0c6gdzcqkkxo
title: 2026 02 27 Workspace Cleanup
desc: ''
updated: 1772197085001
created: 1772196825476
---

# 2026-02-27 Workspace Cleanup Plan

## Summary
Lock recording/export path behavior to deterministic no-UI semantics and defer workspace-driven defaults until a UI exists.

1. `::record` and `::capture` with no target always write to the global default root.
2. In-chat target arguments must be absolute paths.
3. Relative paths and `@mentions` are rejected for in-chat commands.
4. Workspace registration/discovery and workspace-default path templating are deferred.

## Public Interface Changes
1. In-chat command behavior:
- `::record` with no target: allowed, uses global default destination.
- `::capture` with no target: allowed, uses global default destination.
- `::record <target>`: `<target>` must be absolute.
- `::capture <target>`: `<target>` must be absolute.
- `::export <target>`: `<target>` must be absolute.
- `@relative`, relative markdown links, and relative plain paths: rejected.
2. Config/schema:
- No new `workspaces` schema fields in this phase.
- No workspace CLI commands in this phase.
3. Docs:
- Document absolute-path-only in-chat targets.
- Document global default behavior for no-target commands.
- Document workspace features as deferred.

## Implementation Plan
1. Update command-path enforcement in `apps/daemon/src/orchestrator/daemon_runtime.ts`.
- Keep existing no-target global default destination logic.
- Add absolute-path validation for all explicit in-chat targets.
- Reject invalid targets before policy gate execution.
- Emit clear operational and audit logs for rejection reason.
2. Keep `apps/daemon/src/policy/path_policy.ts` context-free.
- No workspace/cwd inference in policy evaluation.
- Continue canonical root allowlist enforcement.
3. Update docs.
- Update `README.md` command semantics and limitations.
- Update `dev-docs/notes/task.2026.2026-02-26-workspace-settings.md` to mark workspace defaults as deferred.
- Add concise rationale in `dev-docs/notes/task.2026.2026-02-27-workspace-cleanup.md`.
4. Add cleanup guidance for stale persisted state.
- Document use of existing session cleanup flow for stale metadata/twin issues.
- Include Gemini hash/slug source-path churn troubleshooting notes.

## Test Cases and Scenarios
1. `tests/daemon-runtime_test.ts`
- `::record` with no target writes under global default root.
- `::capture` with no target writes under global default root.
- `::record notes/a.md` is rejected.
- `::capture @notes/a.md` is rejected.
- `::record [x](notes/a.md)` is rejected.
- `::record /abs/path/a.md` succeeds when inside allowed roots.
2. `tests/command-detection_test.ts`
- Keep detection behavior unchanged; validation is enforcement layer.
3. Logging assertions
- Rejected targets produce deterministic operational and audit events with explicit reason.

## Rollout and Compatibility
1. Treat this as an intentional behavior tightening.
2. Existing relative-path workflows are expected to break.
3. Update docs and troubleshooting before release.
4. No automatic migration for old frontmatter/session semantics in this slice.

## Assumptions and Defaults
1. No UI exists to safely establish or confirm workspace context at command time.
2. Cross-provider determinism is prioritized over convenience.
3. Global default root remains `~/.kato/recordings` (or `.kato/recordings` if home is unavailable).
4. Workspace-aware defaults are deferred to a future UI-backed design.
