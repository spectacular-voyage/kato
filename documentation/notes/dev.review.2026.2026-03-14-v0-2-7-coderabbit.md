---
id: 8w2pwcn5zqlr169m5n5l320
title: 2026 03 14 V0 2 7 Coderabbit
desc: ''
updated: 1773496458291
created: 1773495532804
---

Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@apps/cli/src/commands/web.ts`:
- Around line 369-386: The current start-only branch logs the restart (via
ctx.operationalLogger.info "web.restart.start_only" and
ctx.auditLogger.command("web.restart", {...})) before calling
runWebStartCommand, causing false positive logs if start fails; move both
logging calls to after a successful runWebStartCommand call (i.e., call await
runWebStartCommand(ctx) first, ensure it completed without throwing, then invoke
ctx.operationalLogger.info and ctx.auditLogger.command with the same payloads),
so logs/audit only record the restart when start actually succeeds.

In `@apps/cli/src/commands/workspace_register.ts`:
- Around line 56-58: When shouldAutoRestart is true and you call await
runRestartCommand(ctx), wrap that call in a try/catch so any restart failure is
rethrown with explicit post-registration context; e.g., catch the error from
runRestartCommand and throw a new Error like "Workspace registered successfully
but automatic restart failed: <original message>" (preserve the original error
as the cause or include its stack/message) so operators know registration
persisted even though restart failed.

In `@apps/runtime/src/web/mod.ts`:
- Around line 157-162: The current probe using Deno.kill(pid, 0) swallows all
errors and returns false for any failure; change the catch to discriminate
errors: return false only when the thrown error is Deno.errors.NotFound (process
is dead), return true when the error is Deno.errors.PermissionDenied (process
exists but is inaccessible), and rethrow unexpected errors so callers like
waitForProcessExit and startup/status checks see real failures; update the code
surrounding the Deno.kill(pid, 0) call to inspect the thrown error (err
instanceof Deno.errors.NotFound / err instanceof Deno.errors.PermissionDenied)
and handle each case accordingly.

In `@apps/web/routes/brand/`[asset].ts:
- Around line 1-10: Run the Deno formatter and reformat the exported handler so
the file meets `deno fmt --check`; specifically, run `deno task fmt` (or `deno
fmt`) and re-push the changes to update the code around the exported `handler`
defined with `define.handlers` that calls `redirectLegacyBrandAsset` (ensure
import ordering/spacing and any trailing commas match Deno formatting rules).

In `@documentation/notes/completed.2026.2026-03-11-binary-distributions.md`:
- Around line 429-430: The checklist item marked done needs to reflect CI
reality: change the checked box for "Run the full repo `deno task lint` pass
after the current cross-turn changes settle, not just the focused binary/web
lint slice." from [x] to [ ] in the
documentation/notes/completed.2026.2026-03-11-binary-distributions.md entry so the
document shows the lint/fmt step as incomplete until the full lint/fmt CI
(including fmt) is green; leave a brief comment or TODO next to that checkbox
indicating it will be checked after CI passes.

In `@documentation/notes/dev.feature-ideas.md`:
- Line 9: Replace the misspelled word "overides" (and any other incorrect
variants like "overrids") with the correct spelling "overrides" in the document
text where the phrase "per-session overides" appears; search for occurrences of
"overides" or "overrids" and update them to "overrides" to ensure consistent
correct spelling throughout (e.g., the sentence starting with "thinking and
tools use should use, as default...").

---

Nitpick comments:
In `@documentation/notes/dev.todo.md`:
- Line 91: Reword the sentence to improve clarity and grammar by making it a
proper sentence and referencing the register logic file; for example, change the
fragment "(very remote) risk is duplicate workspaceId across two different
workspace roots on one user’s machine; register logic treats that as a conflict
(workspace_register.ts)" into a single clear sentence such as "There is a very
remote risk of duplicate workspaceId values across two different workspace roots
on a single user's machine; the registration logic in workspace_register.ts
treats this as a conflict." Ensure workspaceId and workspace_register.ts are
mentioned so readers can locate the relevant code.

In `@documentation/notes/release-notes.v0.2.7.md`:
- Around line 1-7: The release-notes file documentation/notes/release-notes.v0.2.7.md
currently contains only front matter; populate it with a concise summary of
v0.2.7 user-facing changes: add bullets for the new `kato web restart` command,
the `workspace register --no-restart` flag, automatic `workspaceId` generation
during `workspace init`, and the summary metrics linking to
sessions/recordings/workspaces; include short descriptions of each change,
reference the PR or author where applicable, and add a brief "Notable fixes" or
"Upgrade notes" section so readers understand impact and migration steps.

In `@documentation/notes/template.task.md`:
- Line 25: Add a short example/placeholder using markdown task checkboxes under
the "## Implementation Plan" heading to show the expected format (use unchecked
"[ ]" and checked "[x]" examples); update the Implementation Plan section in
template.task.md to include one or two sample checklist items so authors know to
use markdown checkboxes when filling this section.

## Codex review decisions

- [x] `apps/cli/src/commands/web.ts` move the start-only restart logging until
      after `runWebStartCommand(ctx)` succeeds so failed starts do not produce
      false-positive restart/audit entries.
- [x] `apps/cli/src/commands/workspace_register.ts` wrap the automatic restart
      in `try/catch` and rethrow with explicit "registration succeeded, restart
      failed" context.
- [x] `apps/runtime/src/web/mod.ts` discriminate `Deno.kill(pid, 0)` errors so
      `PermissionDenied` still counts as alive and unexpected failures are not
      silently swallowed.
- [x] `apps/web/routes/brand/[asset].ts` run the formatter. `deno fmt --check`
      currently reports this file as not formatted.
- [c] `documentation/notes/completed.2026.2026-03-11-binary-distributions.md`
      reopen the completed-note lint checkbox. This review comment looks stale:
      the note already records a full `deno task lint` pass, so changing it back
      to `[ ]` would add churn without improving accuracy.
- [x] `documentation/notes/dev.feature-ideas.md` fix the `overides` / `overrids`
      typo(s) to `overrides`.
- [c] `documentation/notes/dev.todo.md` reword the duplicate-`workspaceId` risk line
      into a clearer sentence that still points readers to
      `workspace_register.ts`.
- [x] `documentation/notes/release-notes.v0.2.7.md` populate the `v0.2.7` release
      notes. This is already done in the current tree.
- [x] `documentation/notes/template.task.md` add example markdown task checkboxes
      under `## Implementation Plan` so new task notes follow the intended
      format.
