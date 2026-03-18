---
id: 3n9iaw5m5tf3nuim7fcjmeu
title: 2026 03 18 V0 2 9 Review Coderabbit
desc: ""
updated: 1773859345040
created: 1773859198247
---

## Coderabbit comments

Verify each finding against the current code and only fix it if needed.

Current triage: 4 follow-ups are complete, 1 comment is a Dendron false
positive and should stay cancelled.

Inline comments:
In `@apps/runtime/src/workspace/registry.ts`:

- [x] Around line 94-95: The workspace equality checks in registry.ts currently
      ignore the new displayName field, so comparisons that determine "unchanged"
      snapshots can drop updates that only change displayName; update the
      comparator(s) that compare workspace objects (the functions/blocks that
      currently compare workspaceRoot and other fields) to include the displayName
      property in their equality checks (in the three comparator sites noted in this
      file), ensuring displayName is considered alongside workspaceRoot when deciding
      if a workspace is unchanged.

In `@dev-docs/notes/dev.release-runbook.md`:

- [c] Line 5: Remove the manual frontmatter timestamp edit by deleting or reverting
  the "updated: 1773788589359" line in dev-docs/notes/dev.release-runbook.md so
  the Dendron-managed 'updated' field is not modified by hand; ensure the file's
  frontmatter contains no manually-set 'updated' key and let Dendron populate it
  automatically. Dendron notes in this vault intentionally keep an `updated`
  frontmatter field; the rule is to avoid hand-editing it, not to remove it.

---

Outside diff comments:
In `@apps/web/src/loaders/sessions.ts`:

- [x] Around line 620-645: Tighten alias-only live recording fallback so rows
      without `workspaceId` still resolve workspace display names from alias-based
      registry metadata and continue to match workspace filters when only
      `workspaceAlias` is available.

---

Nitpick comments:
In `@apps/cli/src/usage.ts`:

- [x] Around line 95-101: Update the usage synopsis string for the "kato workspace
      register" command to include the explicit form name=<display-name> (matching the
      later explanatory line) so users can discover that syntax; locate the usage text
      in apps/cli/src/usage.ts (the string that starts with "Usage: kato workspace
      register ...") and change the --name token in the top-line synopsis to show
      name=<display-name> (or include both forms) so it matches the documented example
      on the later line.

In `@apps/web/src/loaders/sessions.ts`:

- [x] Around line 599-605: The page assembly reads the workspace registry multiple
      times causing extra I/O and potential inconsistent results; modify the code so a
      single registry snapshot (the result of loadRegisteredWorkspaces/katoDir
      currently assigned to workspaceEntries or the variable snapshot) is read once
      and reused: change callers so loadSessionActivityRows() accepts the
      already-loaded registry snapshot (or pass workspaceEntries) and remove the
      second loadRegisteredWorkspaces() call in loadSessionsPageData(), and similarly
      replace the duplicate read at the other location (around the 712-719 block) to
      use the same snapshot variable (workspaceEntries/snapshot) so both filter
      metadata and workspaceOptions come from the identical in-memory snapshot.
