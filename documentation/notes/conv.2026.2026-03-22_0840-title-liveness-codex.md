---
id: title-liveness-78b76dc1
title: 'title: "liveness"'
desc: ''
created: 1774194035975
updated: 1774194035975
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019d15ee-3d73-7710-a886-260e52714acb]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [78b76dc1-4d63-4e07-bc3b-99a3dce6a82c]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-03-22_0724_33

title: "liveness"

Please review [task.2026.2026-03-22-liveness.md](dev-docs/notes/task.2026.2026-03-22-liveness.md) and [AGENTS.md](AGENTS.md) and let me know what you think.

# gpt-5.4_2026-03-22_0724_40

I’m reviewing the task note against the repo guidance first so I can give you concrete feedback, not just surface impressions. I’ll read `AGENTS.md`, the task note, and the primary developer guidance note, then I’ll call out any gaps or risks with line references.

**Findings**

1. Medium: The note is not implementation-ready yet because the actual behavior contract is still undefined. The task proposes cross-tab login redirects and a new liveness interpretation, but `Contract Changes` and `Testing` are empty at [task.2026.2026-03-22-liveness.md#L28](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L28) and [task.2026.2026-03-22-liveness.md#L30](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L30). That conflicts with the repo guidance to define contract changes first and add key tests before broad implementation at [dev.general-guidance.md#L29](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md#L29), [dev.general-guidance.md#L55](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md#L55), and [dev.general-guidance.md#L125](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md#L125). I’d want this note to say what “stale” means, whether stale always maps to `stopped`, and what “all open browser sessions” means in practice.

2. Medium: The main design fork is acknowledged but not captured as an actual open issue or decision. [task.2026.2026-03-22-liveness.md#L22](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L22) asks whether you need process detection or just `stale = stopped`, but both [task.2026.2026-03-22-liveness.md#L24](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L24) and [task.2026.2026-03-22-liveness.md#L26](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L26) are empty. That’s the key architectural decision in the note, so leaving it implicit invites drift.

3. Low: The implementation plan is still just a placeholder and doesn’t satisfy the documented task-note workflow. [task.2026.2026-03-22-liveness.md#L34](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L34) and [task.2026.2026-03-22-liveness.md#L36](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md#L36) only contain a blank checkbox, while [AGENTS.md#L13](/home/djradon/hub/spectacular-voyage/kato/AGENTS.md#L13) and [AGENTS.md#L14](/home/djradon/hub/spectacular-voyage/kato/AGENTS.md#L14) ask for real checkbox items that can be checked off as work proceeds.

**Overall**

The direction seems good, especially the push-back against reporting stale services as healthy. I just wouldn’t start implementation from this note yet. It needs one tightening pass to lock down the contract, record the actual decision about liveness detection, and turn the plan into concrete checkboxes.

If you want, I can rewrite this task note into a sharper implementation-ready version.

# djradon_2026-03-22_0727_59

What do you think about the main design fork? If we go with stale=stopped, there's a possibility the process is running but the heartbeat mechanism is just not working. But that's not horrible, we could just change the status from "running" to "alive".

# gpt-5.4_2026-03-22_0728_09

I’m checking how the repo currently models status and heartbeat so I can answer the design fork in terms that fit the existing system, not just in the abstract. After that I’ll give you a recommendation and where I think the terminology change helps or hurts.

I found an important clue: the repo already distinguishes “daemon state” from “heartbeat freshness” in a few places, and the web UI currently treats stale heartbeat as a kind of uncertain state rather than a hard stop. I’m reading the authoritative source files around that split now so I can tell you whether renaming to `alive` would clarify things or blur them.

The current source confirms a three-state model already exists for the daemon in the web layer: `running`, `stopped`, and effectively “we last heard it was running, but we no longer trust that heartbeat” as `unknown`. I’m pulling one more bit of context from the review/history because there are hints this exact ambiguity has already bitten the project before.

One more repo-level wrinkle showed up: the CLI already documents `stop` as “queue daemon stop request (or reset stale running status),” so collapsing stale into `stopped` would also erase a behavior distinction that the toolchain already knows about. I’m checking that path briefly, then I’ll give you the cleanest recommendation.

I’ve got the recommendation. I’m pulling exact line numbers for the couple of places that already encode the stale-vs-stopped distinction so I can anchor the advice to the current repo behavior instead of hand-waving.

I wouldn’t collapse `stale` into `stopped` at the contract layer. That throws away a real distinction: “we know it stopped” versus “we no longer trust its heartbeat.” The current repo already leans that way: stale is only computed when `daemonRunning` is true in [control_plane.ts](/home/djradon/hub/spectacular-voyage/kato/apps/runtime/src/orchestrator/control_plane.ts#L235), the web chrome maps that to `unknown` rather than `stopped` in [status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/loaders/status.ts#L129), and `kato stop` has a separate “reset stale to stopped” path in [stop.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/stop.ts#L15).

I’d push back on renaming `running` to `alive` unless you also add a real process probe. `alive` has a stronger meaning than “fresh heartbeat,” and the repo already uses it that way for web process checks in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L417) plus [mod.ts](/home/djradon/hub/spectacular-voyage/kato/apps/runtime/src/web/mod.ts#L149). Even then, “process alive” still does not mean “daemon healthy.”

My recommendation is:

- Keep three daemon states semantically: `running`, `stopped`, and `unknown` or `unresponsive`.
- Reserve `stopped` for authoritative stop state.
- Treat stale heartbeat as `unknown`/`unresponsive`, not `stopped`.
- If you want extra clarity later, add a secondary diagnostic like `processAlive: true|false` instead of overloading the primary status label.

If you want a simpler operator-facing UI, I’d simplify the copy, not the model. For example: top-line label `Daemon: unavailable` for stale, while the underlying state remains distinct. That keeps the UX calm without lying to ourselves in the contract.

# djradon_2026-03-22_0730_32

OK, so we just update the CLI so it doesn't say "running" when state is actually stale. I like "unresponsive". So fill out the task note please

# gpt-5.4_2026-03-22_0730_46

I’m fleshing the task note into an implementation-ready version now: locking the stale-state decision, defining the operator-facing wording as `unresponsive`, and turning the empty sections into concrete contract/testing/plan items. After that I’ll point you to the updated note and summarize the shape.

I’ve confirmed the auth/session model and the CLI/web status split, so I can make the note concrete instead of speculative. Next I’m patching the task note with the decision to present stale daemon/web status as `unresponsive` while keeping `stopped` reserved for authoritative stops, plus a cross-tab session-expiry plan.

I’m making one last pass through the current web auth surface before I write the task note sections, just to avoid inventing a browser-sync approach that doesn’t fit the existing app structure. Then I’ll patch the note.

I have enough context now. I’m patching the task note with a concrete contract, a scenario table for the liveness-state redesign, a cross-tab auth-expiry approach, and a real implementation/test checklist so the note is ready to drive work instead of just describing a problem.

Filled out [task.2026.2026-03-22-liveness.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md) with a concrete contract, the `unresponsive` decision, a scenario table for the liveness-state redesign, explicit testing expectations, non-goals, and a real implementation checklist.

The note now keeps `stopped` authoritative, treats stale daemon/web state as derived `unresponsive`, and frames session expiry as shared client-side `401` detection plus cross-tab redirect propagation to `/login`. Two open questions are still called out: whether every authenticated page needs a lightweight auth probe, and whether the web header should also rename `unknown` to `unresponsive` in this task. No tests run since this was a docs-only update.

# djradon_2026-03-22_0757_14

rearding open questions, web header working should also move to "unresponsive"; help me decide about probe vs cross-tab broadcast.

# gpt-5.4_2026-03-22_0757_30

I’m checking which authenticated pages already poll in the browser, because that’s the deciding factor for probe vs broadcast. If some pages are effectively static, relying only on existing live views won’t redirect all tabs promptly enough.

I’ve confirmed the key thing: there are authenticated pages like `Settings` that don’t have their own page-specific live polling, but the shared header does render `HeaderStatusLive` on normal authenticated pages. I’m reading that header now, because it may already give us the minimal global probe we need.

I’ve got a clean recommendation now: don’t choose probe or broadcast as mutually exclusive. Use the existing header poll as the lightweight global auth-expiry probe, and use cross-tab broadcast for fast convergence once any tab sees `401`. I’m updating the task note to record that choice and close the header wording question.

The note is updated. I’m doing a quick sanity check on the wording so I can give you a crisp recommendation without contradictions.

Updated the task note to close both questions in [task.2026.2026-03-22-liveness.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md). The note now explicitly says the web header/chrome should also use `unresponsive`, and that the auth-expiry design is: lightweight global probe via the existing shared header polling, plus cross-tab broadcast once any tab sees `401`.

That hybrid is the right call here. You already have a near-global probe because authenticated pages render [app_header.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/app_header.tsx), which mounts [HeaderStatusLive.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/islands/HeaderStatusLive.tsx), which polls through [use_polled_json.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/islands/use_polled_json.ts). So there’s no need to invent a second dedicated auth probe. But probe alone is not enough, because background tabs can throttle timers and stay stale for a while. Broadcast alone is not enough either, because something still has to discover the expiry first.

I’d implement it as:
- Detect `401` in the shared polling hook instead of silently ignoring non-OK responses.
- On first `401`, emit an `auth-expired` signal with `BroadcastChannel`.
- Add a `localStorage`/`storage` fallback so sibling tabs still converge if `BroadcastChannel` is unavailable or quirky.
- Have every authenticated page listen for that signal and redirect to `/login`.

That gives you one small global detector and fast fan-out, without sprinkling auth logic across every page and island.

# djradon_2026-03-22_0804_16

Sounds good.

I think now that we're integrating the heartbeat into daemon status, can we remove the "HEARTBEAT:" from the heading.

# gpt-5.4_2026-03-22_0804_31

I agree with removing `HEARTBEAT:` from the compact header, but not from the detailed status surfaces. The header in [header_status.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/header_status.tsx) should answer one question quickly, and once heartbeat freshness is folded into daemon state, a second label there mostly adds noise. I’m updating the task note to capture that boundary clearly.

Yes, I think that’s the right move for the compact header.

The current header in [header_status.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/header_status.tsx) shows both `DAEMON:` and `HEARTBEAT:`. If heartbeat freshness is now part of the derived daemon state, the separate `HEARTBEAT:` row becomes redundant in that narrow UI. I’d keep heartbeat details on richer surfaces like the summary/status page, but remove it from the top header so the header just says `running`, `unresponsive`, or `stopped`.

I updated the task note to record that decision in [task.2026.2026-03-22-liveness.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md), including the implementation-plan and testing implications.

# djradon_2026-03-22_0808_55

Claude has a few "A few things worth tightening:

Contract Changes — web unresponsive definition is vague

"current checks no longer support presenting the web service as live"

The discussion names the process probe specifically. The contract should too, so it's unambiguous:

unresponsive: persisted running=true but process probe fails or freshness threshold exceeded

Implementation Plan — step 1 is already done

"document the derived liveness contract in relevant task/code/docs notes before broad implementation"

This task note is that documentation. Either mark it [x] or reword it to reference where in-code docs/comments should land (e.g., inline in the CLI status renderer or a docs/liveness.md).

Cross-tab propagation — mechanism not named

Decisions mention "cross-tab broadcast" but don't name BroadcastChannel. Worth noting explicitly, and whether a fallback (e.g., localStorage storage events) is expected for any supported browser targets, even if just to say "not needed."

Stale heartbeat threshold — implicit

The document says the threshold is unchanged (existing behavior), but doesn't say what it is or where it's defined. A brief pointer ("existing HEARTBEAT_STALE_THRESHOLD_MS constant in ...") would prevent confusion during review.

Table legend missing

The "Persistent Covered / Non-Persistent Covered" column headers are unclear without context. What does persistent mean here — persisted-to-disk status files vs. in-memory? A one-line legend under the table would help.

Testing — last item is regression, not new coverage

"verify existing authenticated API routes still return 401..."

This is testing existing behavior. Fine to include, but flag it as a regression check so reviewers don't wonder why it's listed as new work.

Race condition on simultaneous 401 detection

Two tabs detecting expiry at the same time and both broadcasting is the obvious edge case. Implementation should handle idempotently, but the Testing section could explicitly call this out.

Minor: the "Intentional Divergence Notes" column for Expected Same? = Yes rows reads more like "no divergence" notes. Not wrong, just a slight label mismatch."

The current contract "persisted running=true but process probe fails or freshness threshold exceeded", if the probe fails (and has been working before, i.e., there's not an OS-level lack of support), we should just say stopped. 

Should we get rid of persisted running=true?

# gpt-5.4_2026-03-22_0809_03

I’m checking the exact web-status write/read behavior before I answer, because whether `persisted running=true` should stay depends on how the web status file is used today, not just on the wording in the task note. Then I’ll give you a crisp recommendation and the contract text I’d use.

I’m grabbing the exact startup/stop paths for `kato web` before I answer the `persisted running=true` question, because that flag is probably pulling more weight than just display logic.

I checked the lifecycle paths. `running=true` is not just decoration: it participates in startup acknowledgement in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L25), start-state persistence in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L329), explicit stop/reset in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L468), and the web server’s own heartbeat writer in [server_status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/server_status.ts#L94). So I’m not going to recommend removing it from the underlying status file. What I do think we should remove is its centrality in the prose contract.

I’m going to tighten the note to match the more precise split we just landed on: daemon stale => `unresponsive`, web dead-process probe => `stopped`, and `persisted running=true` stays as internal evidence instead of being the outward contract.

I’m tightening the task note now so it stops forcing symmetry between daemon and web liveness. That symmetry was the real problem in the current wording.

The note is updated with the split contract. I’m doing a quick readback now to make sure I didn’t introduce any wording that still implies false daemon/web symmetry.

No, I wouldn’t remove `persisted running=true` from the underlying web status model.

I would remove it from the outward contract wording, though. For the web service, the stronger rule is:

- `running` if the current PID/process probe says the process is alive
- `stopped` if the current PID/process probe definitively says the process is gone
- `unresponsive` only if current live checks are unavailable or inconclusive

That gives you the behavior you want: a dead probed web process is just `stopped`, even if the last file on disk still says `running=true`.

The persisted flag is still useful internally. It’s part of startup acknowledgement in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L25), explicit start/stop persistence in [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L329) and [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L468), and the server heartbeat writer in [server_status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/server_status.ts#L94). So it still matters for lifecycle and diagnostics even if the displayed state disagrees with it.

I updated the task note to reflect that split in [task.2026.2026-03-22-liveness.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md): daemon stale stays `unresponsive`, web dead-process probe becomes `stopped`, the table now has a legend, the daemon stale threshold points to `DEFAULT_STALE_HEARTBEAT_THRESHOLD_MS = 11_000`, and the cross-tab mechanism is named as `BroadcastChannel` with `localStorage` fallback. No tests run since this was a docs-only change.

# djradon_2026-03-22_0815_22

ok, ready to implemetn? new chat or this one?

# gpt-5.4_2026-03-22_0815_24

This one is fine.

We’ve already built the context, read the repo guidance, and tightened the task note, so staying here is actually better unless you want a hard context reset. I’m ready to implement from this chat.

# djradon_2026-03-22_0817_00

proceed

# gpt-5.4_2026-03-22_0817_13

I’m moving into implementation now. First I’m mapping the exact status-rendering paths and the client-side polling/test setup so we can patch the behavior end to end and keep the task checklist honest as we go.

I found the likely verification points already in the repo, including status renderer tests and web loader tests. Next I’m reading those focused sections so we can patch behavior with minimal churn and add coverage in the right places instead of bolting on new test files unnecessarily.

I’ve confirmed the status wording touchpoints. Now I’m reading the island test setup, because the auth-expiry piece will be much smoother if we fit into the existing Preact test style instead of inventing a new harness.

The implementation breaks cleanly into three slices: CLI/web status wording, compact header cleanup, and shared auth-expiry signaling with tests. I’m locking that plan in now and then I’ll patch the code in that order so we can validate each slice incrementally.

I’m patching the first slice now: daemon/web status renderers and the compact header. This will change the operator-facing language to `unresponsive`, remove the redundant `HEARTBEAT` row, and make `kato web status` treat a dead probed process as `stopped`.

I hit one small follow-on from the first patch: the web status command now wants to print `last heartbeat` for a dead stored process, so I’m wiring that diagnostic field through before moving on.

I’ve finished the first renderer pass and I’m moving into the client/auth slice now. I’m also wiring in focused tests as I go, because a few of these behaviors overlap in subtle ways and I’d rather catch them while the changes are still small.

I’m adding the shared auth-expiry module now and then I’ll hook it into the common polling path. The goal is to keep the logic centralized so every live island gets the behavior automatically instead of us sprinkling redirect code across pages.

The auth-expiry module is in place and wired into the shared poller. I’m on the test pass now: updating the existing status assertions, adding a compact-header test, and adding pure auth-expiry tests so we can verify the cross-tab behavior without needing a browser harness.

I’m about to add the focused tests. One thing I’m also checking in parallel is whether we can cheaply regression-test the web app’s `401`/`302` auth behavior through the actual Fresh `app` object, so we don’t have to settle for only unit-level coverage there.

I’ve got the unit-level coverage in place. I’m doing one more useful pass now: seeing if we can cheaply exercise the actual Fresh app middleware for the `401` JSON / `302` page redirect regression checks, since the repo seems close to supporting that.

I found a reasonable way to regression-check the real Fresh auth middleware without leaving a background heartbeat timer behind: import the app dynamically inside the test, drive `app.handler()`, and then dispatch `unload` so the heartbeat tears down. I’m adding that now as a web-configured test.

The code changes are in; I’m on the first validation run now. I’m splitting the tests by environment so we can see quickly whether anything broke in the CLI/status layer versus the web-configured island/app layer.

The first compile phase passed for all three test groups, which is a good sign. I’m polling the actual results now; if anything fails, I’ll patch that slice before moving on to checklist cleanup.

The first validation flush found two real issues rather than logic bugs: root tests can’t import the hook module because it pulls in `preact/hooks`, and the real app test exposes cleanup gaps in the web heartbeat lifecycle. I’m fixing both directly instead of papering over them.

I’ve fixed the two validation blockers: the poll helper now lives in a non-hook module that root tests can import, and the web heartbeat runtime now cleans up its own listeners on stop/unload. I’m rerunning the same test slices now to see what’s left.

The rerun is through type-check again cleanly. I’m polling results now; if we get green here, I’ll finish with task-note checkbox updates and a quick formatting/targeted check sweep.

The remaining failures are both straightforward. One is just a timezone expectation in a status string; the other is a real dedupe bug in the auth-expiry state cache, where each listener ended up capturing its own copied state object. I’m fixing that shared-state reference now.

The web-configured tests are green. I’m just waiting on the root slice rerun now; if it passes, I’ll do the final cleanup pass on formatting and the task note checklist.

The implementation is behaving now. I’m doing the cleanup pass: formatting the touched code, then I’ll flip the task-note checklist to reflect what’s actually finished so the note stays truthful.

I’m updating the task note checklist in parallel with the final validation run so the note matches the implementation state. If any test still surprises us, I’ll revert just the affected checkbox rather than leaving the note aspirational.

The checklist is updated. I’m just waiting on the combined post-format test run now; after that I’ll give you the concise change summary and exact validation I ran.

Implemented the liveness pass and updated the task note. In [status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/status.ts) and [web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts), stale daemon heartbeat now renders as `unresponsive`, while a dead probed web process renders as `stopped` with last-heartbeat diagnostics instead of `stale status`. In the web UI, [status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/loaders/status.ts) and [header_status.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/header_status.tsx) now use `unresponsive` and the compact header no longer shows a separate `HEARTBEAT` row.

For auth expiry, I added [auth_expiry.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/islands/auth_expiry.ts) and [polled_json.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/polled_json.ts), then wired [use_polled_json.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/islands/use_polled_json.ts) so any live poll that gets `401` triggers redirect plus cross-tab fan-out via `BroadcastChannel` with `localStorage` fallback. I also tightened [server_status.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/server_status.ts) so its shutdown path removes listeners cleanly, and I checked off the implementation plan in [task.2026.2026-03-22-liveness.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-22-liveness.md).

Validation I ran:
- `deno test -A tests/improved-status_test.ts tests/web-summary-loader_test.ts tests/web-auth-expiry_test.ts tests/web-cli_test.ts`
- `deno test --config deno.json -A tests/header_status_test.tsx tests/auth_redirect_test.ts` in [apps/web](/home/djradon/hub/spectacular-voyage/kato/apps/web)

I did not run full `deno task ci`. I left the pre-existing changes in [dev.todo.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.todo.md) alone.

# djradon_2026-03-22_0836_47

detailed commit message

# gpt-5.4_2026-03-22_0837_02

```text
feat(web,cli): tighten liveness status and expire web auth across tabs

- change daemon status rendering so stale heartbeat is reported as `unresponsive`
  instead of still reading as `running`
- change `kato web status` so a definitively dead probed web process is reported
  as `stopped` rather than `stale status`
- keep stale web heartbeat/PID data only as diagnostic detail in CLI output
- rename compact web chrome daemon state from `unknown` to `unresponsive`
  for consistency with CLI wording
- remove the separate `HEARTBEAT` row from the compact web header now that
  heartbeat freshness is folded into daemon state
- add shared polled-JSON auth failure handling so `401` responses trigger a
  logout/redirect flow instead of leaving stale live data rendered
- add cross-tab auth-expiry propagation using `BroadcastChannel` with
  `localStorage`/`storage` fallback so sibling tabs converge on `/login`
- factor shared polling response handling into a non-hook helper so root tests
  can verify auth-expiry behavior without importing Preact hooks
- tighten web status heartbeat shutdown cleanup so unload/stop removes signal and
  DOM listeners cleanly during runtime and tests
- update the liveness task note to record the final daemon/web status contract,
  compact-header decision, and completed implementation checklist
- add focused regression coverage for:
  - daemon CLI `unresponsive` rendering
  - web CLI dead-process `stopped` rendering
  - web chrome/header `unresponsive` wording and heartbeat-row removal
  - shared auth-expiry signaling and idempotent cross-tab redirect behavior
  - real web app auth middleware returning `401` for API routes and `302`
    redirects for page routes
```
