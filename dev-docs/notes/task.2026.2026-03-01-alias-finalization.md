---
id: ssk7ocudcxea841o9ywqk8v
title: 2026 03 01 Alias Finalization
desc: ''
updated: 1772417413847
created: 1772410153437
---

# Alias Finalization

Follow-on task for the live-registration workspace-alias implementation.

The core foundation is in place:

- workspace registry persistence exists
- live catalog refresh for new register/unregister exists
- workspace config content reload exists on command boundaries
- alias-scoped in-chat parsing exists
- workspace `workspaceId` is now persisted into workspace-local config and reused
  on re-registration

What remains is mostly finalization, cleanup, and locking the UX/spec to the
code that should survive.

## Remaining Work

- [x] Rewrite the runtime integration coverage in
  [daemon-runtime_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-runtime_test.ts)
  from the old bare `::init` / `::record` / `::capture` model to the
  alias-scoped command model (`::init-<alias>`, `::record-<alias>`,
  `::capture-<alias>`, `::export-<alias>`, `::stop-<alias>`).

- [x] Add explicit runtime tests for the live-refresh behaviors that are now
  part of the design:
  - new `workspace register` entries become visible without restart
  - `workspace unregister` removes aliases for new commands without breaking
    existing bound state
  - workspace config content changes affect future commands but not already
    active recording cycles
  - alias/root/config-path changes on existing entries remain restart-bound

- [x] Finalize the session-state migration away from the attach-era model:
  remove or fully demote the remaining old single-session recording pointer in
  favor of `workspaceOutputs` (the legacy `workspaceAttachment` and
  `primaryRecordingDestination` metadata fields are now gone).

- [x] Audit status/reporting surfaces so they reflect the new
  per-session-plus-per-workspace model correctly:
  `kato status`, session summaries, and any status counters should handle
  multiple workspace-scoped outputs for one session without collapsing back to a
  single “primary” destination.

- [x] Remove any vestiges of the attach-era CLI:
  `attach`, `attachments`, and `detach` still exist, but they should be cleaned up along with any supporting code that is no longer necessary.

- [x] Update the docs to match the new canonical workspace model everywhere:
  - workspace-local config filename is `.kato/kato-workspace-config.yaml`
  - `.kato/kato-config.yaml` is only the global/daemon config
  - live registration/unregistration is supported without restart
  - alias/root/config-path edits on existing entries are restart-bound
  - alias-scoped in-chat commands are the steady-state UX

- [x] Add end-to-end tests around frontmatter pluralization and append-only
  behavior:
  - `sessionIds`
  - `workspaceIds`
  - `recordingCycleIds`
  - append-only `capture` / `export`

- [x] Confirm that the daemon-side non-persistent and persistent execution
  paths stay behaviorally aligned for alias-scoped commands. The runtime suite
  now exercises alias-scoped flows in both paths.

- [x] Review migration and cleanup boundaries for workspace config files:
  - stop reading legacy `.kato/kato-config.yaml`
  - always write new `.kato/kato-workspace-config.yaml`
  - keep `workspaceId` injection stable and non-destructive

- [x] Clean up the remaining backward-compatibility vestiges:
  - legacy workspace config filename reads
  - legacy frontmatter key aliases

- [x] Create a default kato-workspace-config.yaml template
