---
id: dxghri7zjwd8el4bqespmdw
title: 2026 03 22_v0 2 10 Coderabbit
desc: ''
updated: 1774282062988
created: 1774272351173
---

Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@apps/web/islands/use_polled_json.ts`:
- Around line 39-47: The unauthorized branch in the poll handling calls
signalAuthExpired() even when the request is stale; update the handler in
use_polled_json where loadPolledJson resolves to "unauthorized" to first check
the existing cancelled flag (the same guard used for setData) and only call
signalAuthExpired() if not cancelled (otherwise ignore), keeping the early
return behavior; locate the logic around loadPolledJson, result.kind checks,
cancelled, signalAuthExpired, and setData to apply this guard.

In `@apps/web/src/loaders/sessions.ts`:
- Around line 663-665: The page loader can end up using a default katoDir that
ignores a provided statusPath, causing mixed metadata; in loadSessionsPageData,
compute statusPath first (using resolveDefaultStatusPath/resolveDefaultKatoDir)
and then derive katoDir from options.katoDir OR
resolveKatoDirFromStatusPath(statusPath) instead of unconditionally injecting a
default katoDir; update the call sites that forward options (e.g., to
loadSessionActivityRows) to pass this derived katoDir so status-only inputs
resolve metadata against the correct root.

In `@apps/web/src/polled_json.ts`:
- Around line 19-26: The current branch treats any non-ok response as
"unchanged" and lets 204 fall through to response.json(), which hides real
errors and can throw on no-content; update the status handling in the function
that uses response.ok/response.body?.cancel() to explicitly handle expected
no-update statuses (e.g., if response.status === 304 or response.status === 204)
by cancelling body and returning { kind: "unchanged" }, and for other non-2xx
statuses surface an error (throw or return an { kind: "error", status, message"
} outcome) instead of returning "unchanged"; ensure you only call await
response.json() when response.status indicates a body is present and preserve
the existing { kind: "data", data: await response.json() as T } return for
successful responses.

In `@apps/web/tests/auth_redirect_test.ts`:
- Around line 11-56: The test mutates global env via
snapshotRuntimeEnv/setRuntimeEnv, dynamically imports the app module
(import("../main.ts")), and triggers globalThis.dispatchEvent(new
Event("unload")) with a timeout, making it unsafe for parallel runs; fix by
either (A) adding apps/web/tests/auth_redirect_test.ts to the test:parallel-safe
ignore list in deno.json and run it under the serialized test:env suite, or (B)
refactor the test to avoid global mutation and dynamic import by using an
explicit app factory (e.g., expose a createApp or createHandler factory from
main.ts and call that directly), remove the global unload dispatch and short
sleep, and ensure the test restores runtime env via
snapshotRuntimeEnv/setRuntimeEnv only within its isolated factory-instantiated
app lifecycle.

In `@documentation/notes/dev.feature-ideas.distribution-phase-2.md`:
- Line 5: Revert the manual change to the Dendron frontmatter by restoring the
previous value of the updated field (or removing the manual timestamp so Dendron
can regenerate it) — specifically undo the change to the "updated" frontmatter
entry (the line showing updated: 1774193915290) and ensure no manual edits are
left in the frontmatter; add a brief commit message noting "Revert manual
updated frontmatter — allow Dendron to manage" to prevent re-editing.

In `@documentation/notes/dev.feature-ideas.md`:
- Line 5: Remove the manually edited frontmatter timestamp by deleting or
reverting the `updated: 1774242249060` entry so the note relies on Dendron's
automatic `updated` field management; search for the `updated` frontmatter key
in the dev.feature-ideas note and ensure it's not being manually set anywhere in
the content or metadata.
- Line 12: The sentence contains redundant wording and a typo: replace "thinking
and tools use should use, as default, the settings in config
(defaults/general/workspace) but allow per-session overides, maybe by adding
flags to the '::' commands" with a clearer, corrected version such as "thinking
and tools should, by default, use the settings in config
(defaults/general/workspace) but allow per-session overrides, for example by
adding flags to the '::' commands" — remove the extra "use" and correct
"overides" to "overrides".

In `@documentation/notes/dev.todo.md`:
- Line 5: The frontmatter 'updated' value in documentation/notes/dev.todo.md was
manually changed (the "updated: 1774188215673" line); revert this manual edit so
the 'updated' field is removed or left untouched and allow Dendron to manage it
automatically, ensuring you do not modify the 'updated' frontmatter in the
Future and remove any manual updates in the current PR.

In `@scripts/run-root-test-slices.ts`:
- Around line 1-13: ENV_TEST_FILES currently omits tests that use
withIsolatedEnvironment (e.g., tests/web-auth_test.ts), causing env-mutating
suites to be scheduled in the parallel slice and reintroduce Deno.env races;
update the ENV_TEST_FILES const to include all test files that call
withIsolatedEnvironment (audit the repository for every withIsolatedEnvironment
usage and add each referenced test path such as tests/web-auth_test.ts to the
ENV_TEST_FILES array) so that all environment-mutating suites run in the
env-only slice.
- Around line 41-72: buildCommands currently appends forwardedArgs to the
default positional paths leading to unintended runs; detect positional args
(items in forwardedArgs that do not start with '-') and, when present, replace
the defaults rather than append: in buildCommands for the "test:parallel-safe"
command replace the hardcoded "tests" path with the forwarded positional paths;
in the "test:env" command replace ENV_TEST_FILES with the forwarded positional
paths that intersect ENV_TEST_FILES (if any matching positional paths exist)
otherwise keep ENV_TEST_FILES; preserve non-positional forwarded args and still
include SHARED_TEST_ARGS, and use the constants SHARED_TEST_ARGS and
ENV_TEST_FILES and command names "test:parallel-safe" / "test:env" to locate
where to implement this logic.
- Around line 124-129: The three regex literals inside sanitizeTerminalText are
flagged by the no-control-regex lint rule; fix by moving each pattern to a
module-level RegExp created with RegExp(String.raw`...`) (e.g., const OSC_RE =
new RegExp(String.raw`\u001B\][^\u0007]*(?:\u0007|\u001B\\)`, "g")) and then use
those constants (OSC_RE, CSI_RE, CTRL_RE) in sanitizeTerminalText.replace(...)
instead of inline literals; keep the same patterns and flags so behavior is
unchanged and CI lint will pass.

In `@tests/improved-status_test.ts`:
- Around line 371-374: The test currently asserts an exact timezone-dependent
timestamp string with assertStringIncludes and CLI_APP_VERSION, which can flake;
change the assertion to check only the stable parts (e.g. "kato web
(v${CLI_APP_VERSION}): stopped (http://127.0.0.1:3173/, pid 4242, last heartbeat
") using assertStringIncludes (or equivalent) and then add a separate assertion
that the output matches a time-format pattern (e.g. a regex for "YYYY-MM-DD
HH:MM") rather than an exact timestamp; update tests/improved-status_test.ts
around the assertStringIncludes usage to keep the stable prefix check and add a
regex match for the timestamp fragment so the test is timezone-robust.

---

Nitpick comments:
In `@apps/web/islands/SessionsLive.tsx`:
- Around line 169-193: The effect is causing redundant runs because it depends
on selectedWorkspace while also calling setSelectedWorkspace and repeatedly
reads local storage; update the effect to remove selectedWorkspace from the
dependency array and instead (1) cache the remembered workspace once (e.g.,
store readRememberedSessionsWorkspace() in a ref or memo outside the effect) and
(2) use a functional state update in setSelectedWorkspace (e.g.,
setSelectedWorkspace(prev => prev === resolvedWorkspace ? prev :
resolvedWorkspace)) so you can compare and avoid unnecessary updates; locate
resolveDefaultWorkspaceSelectorValue, setSelectedWorkspace,
readRememberedSessionsWorkspace and selectedWorkspace in SessionsLive.tsx to
implement these changes and ensure hasSelectedWorkspace is computed against the
current state via the functional update or a stable ref rather than as an effect
dependency.

In `@apps/web/src/logging.ts`:
- Around line 62-63: The code calls createWebLoggers() and discards its
auditLogger when options.operationalLogger is missing, wasting work; change to
use a dedicated factory that returns only the operational logger (e.g., add
createOperationalLogger or createWebOperationalLogger) or add an overload/option
to createWebLoggers to build only operationalLogger, and replace the call in the
operationalLogger assignment (reference: operationalLogger, createWebLoggers,
auditLogger, options.operationalLogger) so only the needed logger is
constructed.

In `@deno.json`:
- Around line 19-23: The npm scripts "test:parallel-safe", "test:env",
"test:coverage:parallel-safe", and "test:coverage:env" duplicate the same
11-file test list; centralize that list so it’s maintained in one place (either
in scripts/run-root-test-slices.ts or a single deno.json property) and have
these tasks delegate to that central source; update the tasks to reference the
centralized file-list provider (or call run-root-test-slices.ts) and remove the
inlined duplicate file arguments and --ignore entries so future changes only
need to be made in the single shared location.

In `@documentation/notes/dev.feature-ideas.md`:
- Line 9: Change the feature description sentence "Workspace detail page that
included config options, and the ability to change them." to present tense by
replacing "included" with "includes" so it reads "Workspace detail page that
includes config options, and the ability to change them." ensuring consistency
with other feature descriptions.

In `@tests/web-cli_test.ts`:
- Around line 579-588: The test reads the parsed status into the statusPayload
object and currently asserts configured, state, and port; add an assertion that
statusPayload.stale === false when statusPayload.state === "running" (i.e., in
the same assertion block after checking state/port) to ensure the optional stale
field is explicitly validated for running state; this uses the existing
statusPayload variable in tests/web-cli_test.ts (and the same
statusHarness.stdout parsing) so just add the check alongside the other
assertEquals calls.

In `@tests/workspace-mutations_test.ts`:
- Around line 12-25: The test helper currently hand-writes the shared config
YAML which duplicates defaults; instead import and use the runtime helpers
createDefaultSharedBehaviorConfig, resolveDefaultSharedConfigPath, and
SharedBehaviorConfigFileStore, call resolveDefaultSharedConfigPath(katoDir) to
obtain the canonical config path, create any parent dirs, then persist the
default config produced by createDefaultSharedBehaviorConfig() using
SharedBehaviorConfigFileStore (or its write/save API) so tests use the real
runtime defaults and path rather than hard-coded YAML.

## Codex review decisions

- [x] `apps/web/islands/use_polled_json.ts` unauthorized polling after
      cancellation: Valid. Guarded `signalAuthExpired()` behind the existing
      `cancelled` flag so stale polls do not trigger a logout side effect.
- [x] `apps/web/src/loaders/sessions.ts` statusPath-only mixed metadata:
      Valid. `loadSessionsPageData()` now derives `statusPath` first, resolves
      `katoDir` from that path when needed, and forwards both consistently.
- [x] `apps/web/src/polled_json.ts` 204/304 and hidden error handling: Valid.
      Added explicit `unchanged` handling for no-body/no-update statuses and a
      distinct `error` result for unexpected HTTP failures.
- [x] `apps/web/tests/auth_redirect_test.ts` global env/dynamic import:
      Underlying concern was valid, but the better fix was a Fresh app factory.
      Added `apps/web/web_app.ts`, removed env mutation/dynamic import from the
      test, and kept the test under the web app’s own config instead of trying
      to force it into the repo-root test slice.
- [c] `documentation/notes/dev.feature-ideas.distribution-phase-2.md` revert
      `updated` frontmatter: Cancelled. The note has legitimate content changes;
      reverting only the timestamp would add churn without improving behavior.
- [c] `documentation/notes/dev.feature-ideas.md` revert `updated` frontmatter:
      Cancelled for the same reason; no value in timestamp-only churn here.
- [x] `documentation/notes/dev.feature-ideas.md` typo/redundant wording: Valid.
      Cleaned up the sentence and corrected `overides` -> `overrides`.
- [c] `documentation/notes/dev.todo.md` revert `updated` frontmatter: Cancelled.
      No behavior or documentation gain from timestamp-only changes.
- [c] `scripts/run-root-test-slices.ts` missing env-boundary files such as
      `tests/web-auth_test.ts`: Audited current usage. The suggestion was stale;
      current `ENV_TEST_FILES` already matches the real
      `withIsolatedEnvironment(...)` call sites.
- [x] `scripts/run-root-test-slices.ts` positional args should replace default
      targets: Valid. Implemented flag-aware forwarded-arg parsing so explicit
      targets narrow the right slice instead of being blindly appended.
- [c] `scripts/run-root-test-slices.ts` no-control-regex lint finding:
      Already fixed in current code. The regexes are already module-level
      `RegExp(...)` constants.
- [x] `tests/improved-status_test.ts` exact local timestamp assertion:
      Valid. Kept the stable prefix assertion and switched the timestamp check
      to a format regex.
- [c] `apps/web/islands/SessionsLive.tsx` redundant effect runs: Cancelled for
      now. This is a low-value micro-optimization and not worth destabilizing
      the recently added workspace-memory behavior.
- [x] `apps/web/src/logging.ts` avoid constructing an unused audit logger:
      Reasonable cleanup. Added `createWebOperationalLogger()` and used it in
      the unhandled-request logger path.
- [x] `deno.json` duplicate env file lists across test tasks: Valid.
      Centralized the slice wiring in `scripts/run-root-test-slices.ts`, and
      the task entries now delegate there instead of duplicating the file list.
- [x] `documentation/notes/dev.feature-ideas.md` `included` -> `includes`:
      Valid docs cleanup; fixed.
- [c] `documentation/notes/dev.todo.md` move the two top-level backlog items into a
      `task.*` note: Cancelled. These are lightweight backlog bullets, not a
      concrete implementation task with plan/checklist value yet.
- [x] `tests/web-cli_test.ts` assert `stale === false` for running web status:
      Valid test hardening; added.
- [x] `tests/workspace-mutations_test.ts` use runtime helpers instead of
      hand-written shared config YAML: Valid cleanup; the helper now writes the
      canonical default config via `SharedBehaviorConfigFileStore`.

## Fresh follow-ups

- [ ] Consider adding a dedicated `deno task --cwd apps/web test` and wiring it
      into CI intentionally. `apps/web/tests/*` use the web app’s own import
      map, so they should stay on a web-scoped test path rather than being
      forced into the repo-root split slices.
- [ ] If we add more advanced `deno test` forwarding patterns later, extend the
      new `tests/run-root-test-slices_test.ts` coverage for additional flag
      combinations.

## round 2

Verify each finding against the current code and only fix it if needed.

Inline comments:
In `@apps/web/src/loaders/sessions.ts`:
- Around line 663-665: The loaders compute statusPath and katoDir with
inconsistent precedence: statusPath is set via
resolveDefaultStatusPath(options.katoDir ?? resolveDefaultKatoDir()) which lets
KATO_DAEMON_STATUS_PATH override the passed katoDir, but katoDir is set directly
from options.katoDir ?? resolveKatoDirFromStatusPath(statusPath) causing a
mismatch; change the katoDir resolution to use the same precedence rule as
resolveDefaultStatusPath (i.e., ask resolveDefaultStatusPath/its shared helper
to decide precedence or create a shared helper that checks
KATO_DAEMON_STATUS_PATH before falling back to
options.katoDir/resolveDefaultKatoDir), update both places (the lines computing
statusPath and katoDir and the analogous lines at 802–804) to call that shared
helper, and if extracting a helper that returns a joined path ensure you add
join from `@std/path` to imports.


---

Nitpick comments:
In `@apps/web/web_app.ts`:
- Around line 69-73: Extract the duplicated same-origin check into a helper like
requireSameOrigin(req: Request): Response | null that calls
isSameOriginRequest(req) and returns a 403 Response when false or null when OK,
then replace both occurrences where you currently do if (ctx.req.method !==
"GET" && ctx.req.method !== "HEAD") { if (!isSameOriginRequest(ctx.req)) return
new Response(...); } with a call that checks the method and then does const
sameOriginError = requireSameOrigin(ctx.req); if (sameOriginError) return
sameOriginError; and reuse this helper for the other identical check (the second
block that currently repeats the same-origin logic).
- Around line 56-57: The middleware registered with app.use(async (ctx) => { ...
}) recomputes the pathname using new URL(ctx.req.url).pathname; instead, reuse
the value already stored on the context by previous middleware as
ctx.state.pathname. Locate the anonymous middleware (app.use(async (ctx) =>
...)) and replace the recomputation with reading ctx.state.pathname (and
optionally guard with a fallback if undefined) so you avoid redundant URL
parsing.

In `@tests/web-cli_test.ts`:
- Around line 503-519: The test double for WebProcessLauncherLike has an
incompatible signature: update the webLauncher.launchDetached implementation to
accept the same parameters the production code passes (e.g.,
launchDetached(opts: { hostname: string; port: number }) or (...args) ), ignore
them if unused, and return the same Promise<number> (launchedPid) after saving
status; ensure the function name launchDetached and the WebProcessLauncherLike
contract are respected so the test compiles and matches runtime usage.

## Codex review decisions (round 2)

- [ ] `apps/web/src/loaders/sessions.ts` statusPath/katoDir precedence:
      Valid underlying bug. If `KATO_DAEMON_STATUS_PATH` is set, the current
      code can read live status from one root while loading metadata/config
      from another. The fix should be a shared resolution helper, though, and
      we should audit the same precedence pattern in adjacent loaders instead
      of treating `sessions.ts` as an isolated one-off.
- [c] `apps/web/web_app.ts` extract a `requireSameOrigin()` helper:
      Cancelled. This is real duplication, but only across two very small
      branches. The helper would add indirection without materially improving
      clarity or safety.
- [c] `apps/web/web_app.ts` reuse `ctx.state.pathname` instead of reparsing:
      Cancelled. Technically valid, but this saves one URL parse per request
      in non-hot-path middleware and is not worth churning the new app factory
      for.
- [c] `tests/web-cli_test.ts` make the start-test launcher double accept
      `{ hostname, port }`: Cancelled. Mirroring the runtime signature would be
      slightly nicer, but the bot's "compile-time mismatch" rationale is
      overstated here, and this does not materially strengthen the behavior the
      test is actually asserting.

### PR-side note comments not worth carrying forward

- [x] `documentation/notes/review.2026.20226-03-22_v0-2-10-coderabbit.md` title
      typo `20226` -> `2026`: Already resolved locally. The active review note
      has the corrected title and filename shape.
- [c] review note `updated` frontmatter removal: Cancelled. The problem is
      hand-editing Dendron's `updated` field, not the field existing at all.
- [c] review note code-path references should become Dendron wikilinks:
      Cancelled. Dendron wikilinks are for notes; turning source-file paths
      into fake note links like `[[apps.web.src.loaders.sessions]]` would make
      the review note less accurate, not more.
- [c] review note markdownlint `task.*` wording warning: Cancelled as stale for
      the current local note. The warning was attached to the old typo'd path,
      and the triggering text is not present in this file.
