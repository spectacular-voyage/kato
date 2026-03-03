---
id: clidaemon-separataion-66292647
title: 'CLI/Daemon separataion'
desc: ''
created: 1772564523107
participants: [claude.claude-sonnet-4-6]
kato-sessionIds: [9125521a-a591-4cbc-afec-5560b5265147]
kato-workspaceIds: [7a79504b-3205-411c-a28b-b8a42a8e814f]
kato-recordingIds: [66292647-39ce-4d07-bbf5-2b193127f701]
---

# User_2026-03-03_1101_45

CLI/Daemon separataion

Review @dev-docs/notes/task.2026.2026-03-03-cli-daemon-separation.md and provide feedback.

The user wants me to review the task document for CLI/Daemon separation and provide feedback. Let me read the relevant dev guidance first, then analyze the task document thoroughly.

# claude-sonnet-4.6_2026-03-03_1101_45_Tool-Read

/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md

# claude-sonnet-4.6_2026-03-03_1101_45_Tool-Agent

Now I have a comprehensive understanding of both the task document and the codebase. Let me provide thoughtful feedback on the task document.

Key observations from the codebase:

1. **Current state**: `apps/daemon/src/main.ts` IS both the CLI entrypoint and daemon runtime - confirms the task's analysis.

2. **RuntimeConfig** currently includes both daemon-process-only fields AND shared behavior fields (allowedWriteRoots, exportTimezone, exportMarkdownFrontmatter, exportFeatureFlags) - confirms the config split is needed.

3. **DaemonStatusSnapshot** does NOT currently have a daemon version field - confirms this needs to be added.

4. There's a single `DAEMON_APP_VERSION` that needs to be split into separate CLI and daemon versions, and the `apps/cli/` directory doesn't exist yet - this is the main structural change required. The `kato init` command currently scaffolds runtime, workspace, and user configs but not the shared config that the task proposes.

Now I'm reviewing the strengths and weaknesses of the task document itself - it's well-structured with clear sections and good rationale, though I should examine whether the recommendations are fully aligned with the codebase reality.

The implementation ordering seems off since the process entrypoints (Section F) are foundational but listed last, though they could potentially be deferred. More critically, the Contract Changes section is incomplete - it doesn't specify how to update `resolveDefaultConfigPath()` for the new directory structure or provide a migration strategy for users with existing `~/.kato/kato-daemon-config.yaml` files.

I also notice the `controlPath` and `statusPath` changes aren't called out in Contract Changes even though they're moving to `shared/ipc/daemon-control.json` and `shared/status.json` respectively, which affects both daemon and CLI processes. The filesystem layout restructuring should be explicitly listed as a separate implementation step rather than being buried in the discussion section.

For the export request payload work, I need to be clearer about what's currently in the `ExportRequest` type and exactly which fields to add—exportTimezone, exportMarkdownFrontmatter, exportFeatureFlags—plus whether the daemon should validate and reject incomplete payloads following fail-closed principles. The testing section is also missing coverage for the new path resolution logic and whether `kato init` properly creates the restructured directory layout.

I should also flag that the non-goals section mentions no legacy fallback support, but given how significantly the filesystem layout is changing, this might warrant explicitly calling out as a breaking change that requires manual user migration. Section F about splitting the entrypoint creates a new `apps/cli/` directory that affects where `CLI_APP_VERSION` lives and what the CLI's `deno.json` looks like, so the task ordering might need adjustment—Section C depends on F, or they should be combined. Finally, the task references sourcing version info from `apps/cli/deno.json` but never actually calls out creating that file as an implementation step.

There's also the question of how `DaemonCliCommandContext` gets handled when the CLI moves out—it's currently defined in the daemon's CLI types but will need to either move with the CLI or be split so the CLI only references shared contracts. Moving to a monorepo structure means new import maps, dependency management, and build targets that should be documented. And I'm realizing the `--version` flag implementation details aren't fully specified yet.

# claude-sonnet-4.6_2026-03-03_1101_45

Good document overall — the structure, rationale, and scope are solid. Here's my feedback organized by theme:

---

## Strengths

- Correctly diagnoses the mixed-concerns problem in `RuntimeConfig` (confirmed: it currently holds both daemon-process and shared-behavior fields).
- Clean filesystem layout with clear ownership semantics.
- Non-Goals are well-scoped and prevent scope creep.
- Good testing list that covers the major behavioral changes.

---

## Gaps and Issues

### Path changes aren't in Contract Changes

The filesystem layout (Section 6) moves `statusPath` → `shared/status.json` and `controlPath` → `shared/ipc/daemon-control.json`. These are runtime-observable contract changes that affect both the daemon and the CLI (which need to find each other). They should be explicitly listed in **Contract Changes** alongside the config schema changes, including a note that both processes must agree on the path at runtime.

### Implementation Plan doesn't cover path constant updates

Neither Section A nor Section F calls out updating `resolveDefaultConfigPath()` and related path-resolution helpers to reflect the new `~/.kato/daemon/`, `~/.kato/shared/` layout. Add an explicit item, e.g.:
```
- [ ] Update default path resolution constants for daemon config, shared config, status, and control paths.
```

### Section C depends on Section F, but F is listed last

`CLI_APP_VERSION` is sourced from `apps/cli/deno.json` (Section C), but `apps/cli/` doesn't exist yet — that's Section F. Either reorder (F before C), or add an explicit prerequisite note. Also, the implementation plan doesn't call out **creating `apps/cli/deno.json`** as a step anywhere.

### Monorepo implications of `apps/cli/` are unaddressed

Adding a new `apps/cli/` workspace member requires:
- A new `apps/cli/deno.json` with its own `version` field.
- Adding it to the root `deno.json` workspace member list.
- Deciding how `DaemonCliCommandContext` (currently in `apps/daemon/src/cli/types.ts`) is handled — does it move to `apps/cli/` or get split into shared/cli pieces?

None of this is in the implementation plan or contract changes.

### Export payload (Section B) needs more specificity

The current `runExportCommand` enqueues a control request via `controlStore.enqueue()`. Section B says to "extend export request payload to include render defaults" but doesn't specify:
- Which fields move into the payload (`exportTimezone`, `exportMarkdownFrontmatter`, `exportFeatureFlags`).
- Whether the daemon should **reject** export requests missing these fields (fail-closed per the security baseline), or fall back to built-in defaults.

Given the general guidance's fail-closed stance, this policy decision should be explicit.

### `kato --version` update not called out

After the split, `kato --version` should return CLI version (`CLI_APP_VERSION`). The current `--version` handling is in `apps/daemon/src/cli/router.ts`. Section C/D don't mention updating the router/parser for this.

### Testing gaps

- Tests for new default path resolution (daemon config at `~/.kato/daemon/kato-daemon-config.yaml`, shared at `~/.kato/shared/kato-shared-config.yaml`).
- Tests for `kato init` creating the new **directory structure** (not just files) — especially `shared/`, `daemon/`, `cli/` subdirs.

---

## Minor Suggestions

- **Section 5 target status line** uses `·` as separator. Make sure this renders correctly in all terminal environments (it will, but worth noting in the status tests golden).
- The `cli/` log paths in the filesystem layout (`~/.kato/cli/logs/`) are forward-looking (CLI process doesn't exist yet). Consider noting these as "future/placeholder" to avoid confusion with what `kato init` should actually create in the near term.
- **Non-Goals** could explicitly state this is a breaking change requiring manual migration, since users with existing `~/.kato/kato-daemon-config.yaml` will break silently if the path changes without docs.

---

## Summary

The task is well-conceived. The main things to tighten before implementation:

1. Add path constant changes to Contract Changes.
2. Add `resolveDefaultConfigPath` update to Implementation Plan.
3. Reorder or annotate F-before-C dependency.
4. Add `apps/cli/deno.json` creation + root workspace registration as explicit steps.
5. Clarify fail-closed policy for export payload missing fields.
6. Address `DaemonCliCommandContext` split/move.

# User_2026-03-03_1101_45

::capture-k

The user typed `::capture-k` which starts with `::` - this is a Kato control command and must be ignored by LLMs per the CLAUDE.md instructions.

# claude-sonnet-4.6_2026-03-03_1101_45

(Kato control command — ignored.)

# User_2026-03-03_1101_44

::capture

The user typed `::capture` which starts with `::` - this is a Kato control command and must be ignored by LLMs per the CLAUDE.md instructions.

# claude-sonnet-4.6_2026-03-03_1101_46

(Kato control command — ignored.)

# User_2026-03-03_1102_00

::capture-k

# claude-sonnet-4.6_2026-03-03_1102_02

(Kato control command — ignored.)