---
id: test-global-lock-89f87f20
title: 'test global lock'
desc: ''
created: 1773865522856
updated: 1773865522856
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019d0298-a9e5-71e2-9c5d-c76d252cfc1c]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [89f87f20-d85b-4413-b55f-b563c623da93]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-03-18_1318_09

test global lock

I'm interested in re-enabling parallel test execution. Can you review [task.2026.2026-03-12-replace-test-global-lock.md](dev-docs/notes/task.2026.2026-03-12-replace-test-global-lock.md) and let me know your assessment?

# gpt-5.4_2026-03-18_1318_16

I’m reviewing the task note against the repo’s developer guidance first, then I’ll trace the current test-locking setup in code so the assessment is grounded in how the suite actually works today.

I’ve got the task note and the repo guidance. Next I’m checking whether the note still matches the codebase today: current test task settings, the real lock helper behavior, and how widely `withLockedEnvironment(...)` is still used.

The task note’s core diagnosis looks plausible, but the current lock surface is wider than the note claims. I’m drilling into the actual categories now so I can separate “good strategy” from “missing scope” and “likely duplicate work.”

I’m mapping the remaining lock usage by intent now. The main question isn’t just “is the direction right?” but “how much of this surface is really migratable versus legitimate env-boundary coverage.”

The note is definitely not aligned with current docs yet: `dev.testing` still treats root `deno task test` as parallel by default, while the task note assumes the root flow should stay serial. I’m checking the highest-leverage lock users now to see which ones are actually easy wins versus true env-contract tests.

A useful pattern is showing up: some lock-heavy tests are true env-contract tests, but others look like they’re only mutating `HOME` because the code path still calls a default resolver internally. I’m checking the web/runtime modules with direct default-path reads so the assessment can be specific about where new seams are actually needed.

Some of the web/runtime surface already has the right override shape, so part of this is test cleanup rather than API design. A few modules still hard-wire default resolution though, which is where additive seams would actually pay off.

A big chunk of the lock surface is in route-style web tests that already build explicit temp roots and then still rewrite `HOME` just to make default resolvers line up. That supports the overall strategy, but it also means the task note should be more explicit about which slices are “test-only rewrites” versus “production seam additions.”

The route tests are a good example of scope drift: `runSessionRecordingAction()` and `loadSessionsPageData()` already accept `katoDir` overrides, but some higher-level entry points still don’t. That means the task should explicitly distinguish “leaf APIs already fixed, route entry points still defaulting.”

I wanted to sanity-check one point instead of hand-waving it: whether the current root task is actually serial or already using Deno’s built-in parallelism semantics. That matters because the task note talks about “restoring” parallelism, and I don’t want to rely on a fuzzy memory there.

The CLI help is a bit annoyingly terse here, so I’m reading the exact `--parallel` wording before I treat the repo docs or the task note as authoritative. This is one of those places where a small wording mismatch can send the whole plan in the wrong direction.

**Findings**
1. High: the task note is working from a stale inventory. It says there are `68` `withLockedEnvironment(...)` sites at [task.2026.2026-03-12-replace-test-global-lock.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-12-replace-test-global-lock.md#L35), but the repo currently has `89` across `24` test files. Some of the biggest current users are not in the migration buckets, including [web-session-actions_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/web-session-actions_test.ts#L153), [web-recordings-page-post_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/web-recordings-page-post_test.ts#L190), and [runtime-config_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/runtime-config_test.ts#L181). I’d refresh the inventory before treating the buckets as a plan.

2. High: the note does not define the current parallelism baseline clearly enough. It says to keep root `deno task test` serial and avoid restoring root `--parallel` at [task.2026.2026-03-12-replace-test-global-lock.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-12-replace-test-global-lock.md#L159) and [task.2026.2026-03-12-replace-test-global-lock.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-12-replace-test-global-lock.md#L191), but the repo docs still say root `test` uses module parallelism by default at [dev.testing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.testing.md#L48), while the actual task definition at [deno.json](/home/djradon/hub/spectacular-voyage/kato/deno.json#L18) does not pass `--parallel`. That mismatch needs to be resolved first or the success criteria stay fuzzy.

3. Medium: the plan overstates how much new production seam work is required. There are immediate low-risk test-only wins. For example, [cli-command-direct_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/cli-command-direct_test.ts#L312) takes the global env lock just to create and clean up a temp dir, even though [test_temp.ts](/home/djradon/hub/spectacular-voyage/kato/tests/test_temp.ts#L54) already provides isolated temp-dir helpers. I’d explicitly split “remove unnecessary lock usage in tests” from “add product injection seams.”

4. Medium: some important env-coupled entry points are missing from the candidate buckets. [activity_state.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/loaders/activity_state.ts#L9), [workspaces.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/loaders/workspaces.ts#L64), [logging.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/logging.ts#L9), and [recordings_page_post.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/recordings_page_post.ts#L83) still default-resolve paths internally. That is why higher-level web tests like [web-recordings-page-post_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/web-recordings-page-post_test.ts#L190) still rewrite `HOME` even when lower-level helpers already accept `katoDir`.

5. Medium: the note understates the true env-boundary surface. Its summary only calls out `HOME`, `USERPROFILE`, `KATO_RUNTIME_DIR`, and `KATO_WEB_PASSWORD` at [task.2026.2026-03-12-replace-test-global-lock.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-12-replace-test-global-lock.md#L25), but the current boundary tests also cover `KATO_DAEMON_STATUS_PATH` / `KATO_DAEMON_CONTROL_PATH` in [daemon-control-plane_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/daemon-control-plane_test.ts#L31), path-policy env in [path-policy_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/path-policy_test.ts#L20), and config/provider/logging env in [runtime-config_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/runtime-config_test.ts#L29). Those are legitimate env-contract tests, not just incidental lock users.

**Overall**
Directionally, I think the note is right: shrinking env-coupled tests is much better than inventing a smarter global lock. But I would not start implementation from this exact note as-is. It needs a refreshed inventory, a corrected statement of the current test-parallelism baseline, and a clearer split between `true env-boundary tests`, `test-only de-locking`, and `missing production seams`.

My bias for the end state is a composed flow: keep a very small serial env-boundary slice and let the rest run parallel, instead of trying to make every test pretend process env does not exist. I didn’t run the full suite; this assessment is from reviewing the note, the current test/task definitions, the lock helper, and the affected test/code paths.

# djradon_2026-03-18_1323_16

the goal is to support --parallel to the extent possible. Please refresh inventory, clarify and split where appropriate,  and prepare for implementation.

# gpt-5.4_2026-03-18_1323_27

I’m refreshing the lock inventory into concrete buckets now, then I’ll update the task note so it’s implementation-ready instead of leaving the plan half-implicit.

I’ve got the broad buckets. I’m reading the ambiguous edge files now so the refreshed inventory doesn’t overcount boundary tests as migration candidates.

I’ve narrowed the remaining ambiguity. The last pass is checking which “default-path” APIs already accept `katoDir`/`runtimeDir` so the task note can call out easy rewrites separately from true production seam work.

I’ve got a clean split now. I’m updating the task note to reflect the real 89-site inventory, separate easy test-only lock removal from missing product seams, and reframe the end state around usable `deno test --parallel` support rather than “maybe restore parallelism later.”
