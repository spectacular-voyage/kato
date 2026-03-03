---
id: please-review-dev-docsno-902f2d53
title: 'please review @dev-docs/notes/task.2026.2026-03-03-fix-defa…'
desc: ''
created: 1772557799498
updated: 1772557799498
participants: [user.djradon, claude.claude-sonnet-4-6]
kato-sessionIds: [0431dbb7-dea7-4352-ae6d-f341047b17fe]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [902f2d53-17e5-4680-950b-770a159f900d]
conversationEventKinds: [message.assistant, message.user, thinking, tool.call, tool.result]
---

# User_2026-03-03_0903_30

please review @dev-docs/notes/task.2026.2026-03-03-fix-default-user.md and provide feedback.

The user wants me to review the task document they've shared. Let me read the general guidance first, then provide feedback on the task document.

# claude-sonnet-4.6_2026-03-03_0903_33_Tool-Read

/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md

Now let me review the task document and provide feedback. Let me also look at the existing codebase to understand the current state before providing feedback.

# claude-sonnet-4.6_2026-03-03_0903_36

Let me also look at a few relevant existing files to give grounded feedback.

# claude-sonnet-4.6_2026-03-03_0903_37_Tool-Glob

apps/daemon/src/config/**/*.ts

# claude-sonnet-4.6_2026-03-03_0903_37_Tool-Glob

apps/daemon/src/main.ts

# claude-sonnet-4.6_2026-03-03_0903_39_Tool-Read

/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/config/mod.ts

# claude-sonnet-4.6_2026-03-03_0903_40_Tool-Glob

shared/src/contracts/config.ts

# claude-sonnet-4.6_2026-03-03_0903_40_Tool-Glob

apps/daemon/src/orchestrator/daemon_runtime.ts

# claude-sonnet-4.6_2026-03-03_0903_42_Tool-Read

/home/djradon/hub/spectacular-voyage/kato/shared/src/contracts/config.ts

# claude-sonnet-4.6_2026-03-03_0903_43_Tool-Grep

defaultParticipantUsername

Let me look at a few more files to understand the existing structure better before providing feedback.

# claude-sonnet-4.6_2026-03-03_0903_47_Tool-Grep

defaultParticipantUsername|addParticipantUsername

# claude-sonnet-4.6_2026-03-03_0903_48_Tool-Grep

defaultParticipantUsername|addParticipantUsername

Now I have a good understanding of the current state and the task document. Let me provide feedback on the task document.

The task document is fairly well-structured. Let me analyze it against the guidance in `dev.general-guidance.md`:

Sections needed per guidance:
- Goal ✅
- Summary ✅ (called "Problem Summary")
- Discussion ❌ (missing)
- Contract Changes ❌ (missing)
- Testing ✅ (called "Test Plan")
- Non-Goals ✅
- Implementation Plan ✅

Other observations:

1. **Missing "Discussion" section** - The guidance requires a "Discussion" section, which is not present. The design rationale is embedded in "Proposed Design (Decisioned)" but it's more of a spec than a discussion.

2. **Missing "Contract Changes" section** - Since the task modifies `shared/src/contracts/config.ts` with changes to `defaultParticipantUsername` and introduces a new user config type, this section would clearly document what's being added, deprecated, or modified.
3. **Section naming inconsistency** - Using "Problem Summary" and "Test Plan" instead of the guidance's "Summary" and "Testing" is a minor deviation worth noting.
4. **"Proposed Design (Decisioned)"** - The "(Decisioned)" qualifier feels awkward and could simply be "Design" since the task is already decided.
5. **Open Questions section** - The username normalization question about case policy needs resolution before implementation starts. Given the current lowercase slug policy, this should be stated as resolved rather than left open.
6. **Implementation Plan gaps** - Section A doesn't clarify whether `UserConfigFileStore` loading should be fail-closed or fail-open; Section B's "Update CLI usage/help text" needs specifics about which commands; and Section E on kato user commands seems ambitious without clarity on whether it's in scope or deferred.
7. **Missing documentation updates** - The plan doesn't mention updating `dev.codebase-overview` and `dev.decision-log` before merge, and the test plan doesn't cover the kato user command group if it's in scope.
8. **Docs structure issue** - Documentation updates should be integrated into the implementation plan with checkboxes rather than listed as a separate section.
9. **workspaceId stability** - The design calls it "not alias" for stability, but it's worth clarifying whether this refers to a UUID-style ID or another stable identifier, especially since users interact with aliases.
10. **Fail-closed startup requirement** - Need to verify the fail-closed behavior applies consistently across all startup paths.
11. **Pattern consistency** - The `UserConfigFileStore` mirrors `RuntimeConfigFileStore`, so I should confirm whether the same methods like `load()` and `ensureInitialized()` should be strictly followed.
12. **Alias resolution in commands** - The design uses `workspaceId` as keys for stability, but the `kato user map` commands accept `<workspace-alias-or-id>` and need to resolve aliases to the underlying ID.

Now looking at the next part, there's a dependency issue: if the workspace registry becomes unavailable when running these commands, the alias resolution fails. Beyond these specific points, the task is mostly solid but has a few structural gaps—it's missing the "Discussion" and "Contract Changes" sections that the guidance recommends, the username normalization question remains unresolved, the documentation updates should be tied to implementation with checkboxes, and I need to clarify whether the `kato user` commands in section E are truly part of this task or a follow-up. The fail-closed behavior for user config loading also needs to be stated explicitly in the design section.

Here's my feedback on the task document:

---

## Overall Assessment

The design is solid and well-reasoned. The precedence table, compat window, and non-goals are all clear. A few gaps and structural issues follow.

---

## Structural Gaps (vs. `dev.general-guidance.md`)

The guidance specifies these required sections:

| Required | Present |
|---|---|
| Goal | ✅ |
| Summary | ✅ (named "Problem Summary") |
| **Discussion** | ❌ missing |
| **Contract Changes** | ❌ missing |
| Testing | ✅ (named "Test Plan") |
| Non-Goals | ✅ |
| Implementation Plan | ✅ |

**Discussion** should capture the "why" behind the design choices—e.g., why `workspaceId` over alias as the map key, why `excludeMeFromParticipantList` rather than a simpler boolean opt-in, why not auto-migrating the old key. Right now rationale is embedded but not labeled.

**Contract Changes** is especially important here since `shared/src/contracts/config.ts` is being touched (deprecating `defaultParticipantUsername`) and a new user config type is being introduced. Should list all additions/deprecations/removals.

---

## Specific Feedback

**Open question should be closed.** The username normalization question (line 165–167) should be resolved before implementation. The slug policy (`lowercase`, `[a-z0-9._-]`) is already used in both `main.ts` and `daemon_runtime.ts` — just commit to keeping it and close the question.

**Docs Update Plan should be integrated into the Implementation Plan.** Per guidance, implementation plan items should be markdown checkboxes. The "Docs Update Plan" section has the right content but sits outside the checkbox-tracked plan, so it won't get checked off.

**Section E scope.** The `kato user` command group is a significant surface area. Is it truly in scope for this task, or should it be tracked as a follow-up? The non-goals section doesn't mention it, but it's larger than sections A–D combined. If it's in scope, the test plan should include `kato user` command tests.

**Fail-closed policy for user config.** General guidance says daemon startup is fail-closed. Section A says "fail-closed unknown keys" for the parser, but the design should explicitly state: if `~/.kato/kato-user-config.yaml` exists with unknown keys, does the daemon refuse to start, or does it warn and continue? If it's user-local (not shared), a warn-and-continue policy may be more appropriate—but it should be a stated decision.

**Missing pre-merge checklist items.** Guidance requires updating `dev.codebase-overview` and `dev.decision-log` before merge. These aren't in the implementation plan.

**"(Decisioned)" qualifier** on the Proposed Design header is a bit awkward. Just calling it "Design" or "Proposed Design" is cleaner—the task note itself is the decision record.

---

## Minor

- `UserConfigFileStore` name mirrors `RuntimeConfigFileStore` — good consistency.
- `workspaceId` as map key (not alias) is the right call; the alias→id resolution in the `kato user map` commands handles UX. Worth noting what happens if the workspace registry is unavailable when running those commands (error out? match by alias prefix?).

# User_2026-03-03_0909_57

you can ignore this kato command:

::capture-k

# claude-sonnet-4.6_2026-03-03_0909_58

Understood, ignoring `::capture-k`.