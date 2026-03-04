---
id: ej6eythu7vckkmfqp52fa1l
title: 2026 03 04_0622 Coderabbit Hodgepodge
desc: ""
updated: 1772634154710
created: 1772634152051
---

Verify each finding against the current code and only fix it if needed.

Inline comments: In `@apps/runtime/src/orchestrator/control_plane.ts`:

- Around line 262-265: The error message thrown when homeDir is falsy (the throw
  new Error in control_plane.ts) currently suggests "~/.kato/daemon" which is
  not an absolute path; update the string to show a real absolute-path example
  (e.g. "/home/<user>/.kato/daemon" or "/var/lib/kato/daemon") and keep the
  instruction to set KATO_RUNTIME_DIR to an absolute path so the message
  correctly reflects the failure context and guides users to provide an absolute
  path.

In `@apps/runtime/src/orchestrator/session_state_store.ts`:

- Around line 665-674: The early return after finding canonicalMetadata skips
  the index healing/update step and can leave stale daemon-control.json entries;
  instead of returning immediately from the canonicalMetadata branch, always
  call normalizeMetadataStoragePaths(canonicalMetadata,
  canonicalPaths.metadataPath, canonicalPaths) and then invoke the same
  daemon-index/daemon-control.json update logic used for non-canonical paths
  (the code that writes/repairs the daemon index). In short: remove the early
  return for the canonicalMetadata case and ensure both branches run the
  normalizeMetadataStoragePaths call followed by the daemon index healing/update
  routine so stale entries are repaired even when metadata is already canonical.

In `@dev-docs/notes/dev.codebase-overview.md`:

- Around line 37-52: The docs mention the old workspace config filename
  "<workspace>/kato-workspace-config.yaml" but the codebase now expects
  "<workspace>/.kato-workspace-config.yaml"; locate occurrences of the string
  "<workspace>/kato-workspace-config.yaml" (e.g., in the dev docs section
  describing workspace config filename) and update the text to
  "<workspace>/.kato-workspace-config.yaml" and any surrounding prose to match
  current behavior so the documentation and examples are consistent with the
  runtime filename.

In `@README.md`:

- Around line 47-56: The README's .zshrc alias example contains an extra closing
  double-quote in the alias declaration for "kato"; edit the alias line (alias
  kato="deno run -A ~/github/kato/apps/cli/src/main.ts"") to remove the stray
  quote so it becomes a valid shell alias (alias kato="deno run -A
  ~/github/kato/apps/cli/src/main.ts") and verify the alias declaration in
  .zshrc loads correctly by restarting the shell or sourcing the file.

In `@tests/daemon-cli_test.ts`:

- Around line 77-108: The tests call snapshotRuntimeEnv(), setRuntimeEnv(), and
  restoreRuntimeEnv() which access the KATO_RUNTIME_DIR env var via
  RUNTIME_ENV_KEYS, but the test task in deno.json is missing KATO_RUNTIME_DIR
  from its --allow-env whitelist; edit the test task's permissions string to add
  KATO_RUNTIME_DIR so it reads, e.g.,
  --allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR.

---

Nitpick comments: In `@apps/runtime/src/workspace/registry.ts`:

- Line 17: The constant DEFAULT_WORKSPACE_CONFIG_FILENAME currently hardcodes
  the new filename and will miss existing projects using the old name; add a
  short legacy-fallback check so discovery accepts both names. Define a
  LEGACY_WORKSPACE_CONFIG_FILENAME (e.g., "kato-workspace-config.yaml") and
  update the workspace discovery logic (the function that reads/locates the
  workspace config in this module) to prefer DEFAULT_WORKSPACE_CONFIG_FILENAME
  but fall back to LEGACY_WORKSPACE_CONFIG_FILENAME if the new file isn’t
  present; log a deprecation/info message when the legacy file is used to guide
  users to rename it.

In `@dev-docs/notes/dev.todo.md`:

- Line 104: Replace the ambiguous backlog item "[ ] rename workspace to
  destination and maybe sessions -> chats" with two explicit checklist tasks:
  one "[ ] Decide terminology: workspace → destination" and one "[ ] Decide
  terminology: sessions → chats"; for each task add clear acceptance criteria
  (e.g., approved term confirmed in README and codebase strings updated or a
  decision document created, and PR opened to implement changes) and assign
  owner and target date so the items are actionable and closable.

In `@README.md`:

- Around line 22-28: The phrase "In the meantime" in the README paragraph that
  introduces the clone instructions should be simplified for concision; update
  that sentence (the paragraph that begins "Eventually, we'll have binary
  distributions. In the meantime, you have to clone the repo:") to use "For now"
  or "Until then" instead of "In the meantime" so it reads e.g. "Eventually,
  we'll have binary distributions. For now, you have to clone the repo:" and
  leave the rest (the git clone command block) unchanged.

In `@tests/daemon-cli_test.ts`:

- Around line 77-108: The three duplicated helper functions snapshotRuntimeEnv,
  setRuntimeEnv, and restoreRuntimeEnv should be extracted into a shared test
  helper module (e.g., tests/test_env.ts) and imported where needed; create a
  new file exporting these functions (preserving the RUNTIME_ENV_KEYS constant
  and RuntimeEnvKey type) and replace the local definitions in
  tests/daemon-cli_test.ts, tests/daemon-control-plane_test.ts, and
  tests/daemon-main_test.ts with imports from that module so each test file
  calls snapshotRuntimeEnv(), setRuntimeEnv(), and restoreRuntimeEnv() from the
  shared helper.

In `@tests/daemon-runtime_test.ts`:

- Around line 3652-3653: Replace the brittle exact-order assertion on
  processedRequestIds with outcome-focused checks: keep asserting exportCalls
  === 0, assert that processedRequestIds includes "req-live-stop" (the live stop
  was processed), and assert that processedRequestIds does NOT include the
  startup request id "req-startup-stop" (startup requests were not replayed);
  reference the variables processedRequestIds and exportCalls and update the
  test assertions accordingly to be order-independent.

In `@tests/session-state-store_test.ts`:

- Around line 188-207: The test currently verifies paths and cleanup but not
  that twin event content was preserved; add an assertion that the migrated twin
  file at canonicalLocation.twinPath contains the same payload as the original
  twin (read the file contents from canonicalLocation.twinPath and compare
  against the original twin data used to create the session or against
  restored's in-memory payload if available). Locate the check block around
  restored, canonicalLocation, legacyTwinPath and
  restartedStore.loadDaemonControlIndex(), read the canonicalLocation.twinPath
  contents (e.g., via Deno.readTextFile/Deno.readFile) and assert equality with
  the expected twin payload, leaving the existing path and NotFound assertions
  intact.

## Codex review decisions

- [x] `apps/runtime/src/orchestrator/control_plane.ts` absolute-path example in
      HOME/USERPROFILE error: Valid UX nit, but must stay cross-platform. Keep
      `~/...` accepted and reword with platform-neutral guidance (for example:
      `/home/<user>/.kato/daemon` **or** `C:\\Users\\<user>\\.kato\\daemon`),
      rather than a Unix-only absolute-path example.
- [x] `apps/runtime/src/orchestrator/session_state_store.ts` canonical metadata
      early-return skips daemon index healing: Valid. Current canonical
      fast-path can miss stale `daemon-control.json` repair. We should ensure
      index entry healing runs even when metadata/twin paths are already
      canonical.
- [x] `dev-docs/notes/dev.codebase-overview.md` old workspace filename docs:
      Valid. Doc still says `<workspace>/kato-workspace-config.yaml` and should
      be updated to `<workspace>/.kato-workspace-config.yaml`.
- [x] `README.md` zsh alias has extra quote: Valid bug in docs. Alias line is
      currently malformed and should be fixed.
- [x] `tests/daemon-cli_test.ts` + `deno.json` env allowlist
      (`KATO_RUNTIME_DIR`): Already fixed and verified with `deno task test`.
- [c] `apps/runtime/src/workspace/registry.ts` legacy workspace-config fallback:
  Cancelled for now. This is a product-compatibility decision, not a clear bug.
  Adding dual-name discovery now risks ambiguity/long-tail behavior. Revisit
  only with explicit migration policy.
- [x] `dev-docs/notes/dev.todo.md` split ambiguous terminology TODO: Reasonable
      cleanup; worthwhile as docs hygiene.
- [c] `README.md` “In the meantime” -> “For now” wording: Cancelled. Pure style
  preference; no correctness impact.
- [x] `tests/*` extract env helpers into shared module: Reasonable refactor; low
      risk and removes duplication across `daemon-cli_test`,
      `daemon-control-plane_test`, and `daemon-main_test`.
- [c] `tests/daemon-runtime_test.ts` switch to order-independent assertions:
  Cancelled. Suggested expectation conflicts with intended behavior in this test
  (`clearControlQueueOnStartup` still marks stale startup requests processed).
  Current explicit sequence is intentional signal.
- [x] `tests/session-state-store_test.ts` assert migrated twin payload: Valid
      test-hardening gap. Add content equality assertion in the migration
      scenario.
