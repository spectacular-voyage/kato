---
id: q2ab6ph01rb7bpeww747p1e
title: 2026 05 11 V0 2 12
desc: ''
updated: 1778558299791
created: 1778558299791
---

Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@apps/cli/src/commands/status.ts`:
- Around line 484-496: Extract the duplicated endpoint resolution into a shared
helper named resolveWebEndpoint that accepts (stored, config, alive, stale) and
returns { hostname, port, url }; replace the inline logic in status.ts (the
block using useStoredEndpoint, hostname, port, url) and the equivalent block in
web.ts with calls to this helper so both use identical resolution behavior;
ensure the helper mirrors the proposed signature and logic (useStoredEndpoint =
alive || stale, choose stored vs config precedence, and build url as
`http://${hostname}:${port}/` when hostname and port are present).

In `@apps/cli/src/commands/web.ts`:
- Around line 198-199: The fallback for heartbeatAt uses new
Date().toISOString() causing an inconsistent time source; change the fallback to
use the injected runtime clock by replacing new Date().toISOString() with
ctx.runtime.now().toISOString() where heartbeatAt is assigned (the expression
that currently reads heartbeatAt: acknowledgedAfterFetch?.heartbeatAt ?? new
Date().toISOString()), so the code consistently uses ctx.runtime.now() across
acknowledgedAfterFetch and related logic.

In `@apps/runtime/src/web/mod.ts`:
- Around line 400-431: isWindowsHostPortListening can hang because await
command.output() is unbounded; wrap the per-port probe in a short timeout using
an AbortController (or equivalent signal) so the powershell child can't block
selectAvailableWebPort indefinitely. Specifically, in
isWindowsHostPortListening, create an AbortController with a small timeout (e.g.
1–2s), pass its signal to command.output() if supported (or on timeout call
command.kill()/close the process), and ensure the timeout/abort is caught and
returns false; update any error handling around the await command.output() call
to handle aborts cleanly.

In `@documentation/notes/dev.todo.md`:
- Line 19: Update the markdown heading "## Runtime And Ingestion Follow-upst" to
correct the typo by changing "Follow-upst" to "Follow-ups" so the heading reads
"## Runtime And Ingestion Follow-ups"; ensure only the heading text is modified
and spelling is consistent with other headings like "Runtime And Ingestion".

---

Nitpick comments:
In `@apps/web/tests/login_page_test.tsx`:
- Around line 5-11: Add a new test that renders the LoginForm with error={true}
and asserts the error UI appears: create a Deno.test (e.g., "login page shows
error message when error is true") that calls renderToString(<LoginForm
error={true} />) and uses assertStringIncludes to check for the error
container/class (e.g., 'class="danger"') and the error text ("Invalid username
or password"), mirroring the existing test's use of renderToString and
assertStringIncludes so it lives alongside the current "login page autofocuses
the username input" test.