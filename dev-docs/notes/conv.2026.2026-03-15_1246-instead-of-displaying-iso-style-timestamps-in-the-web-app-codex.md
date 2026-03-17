---
id: instead-of-displaying-is-edae3e41
title: 'Instead of displaying ISO-style timestamps in the web app, …'
desc: ''
created: 1773603978022
updated: 1773603978022
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019cf2fd-a1b8-74a1-8452-b87c59595bb2]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [edae3e41-2669-4c6b-a589-86afd12617c0]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-03-15_1235_26

Instead of displaying ISO-style timestamps in the web app, we should display in user's local time, in friendlier format like 2026-03-15 12:32:56 i.e. on Recordings, sessions, and maintenance/logs pages -- Should we make a task note for this?

# gpt-5.4_2026-03-15_1235_35

I’m checking the task-note conventions in this repo and the current timestamp usage so we can decide cleanly whether this should be tracked as a note and, if so, capture it in the right format.

I found that a task note for this already exists at [dev-docs/notes/task.2026.2026-03-15-legible-timestamps.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-15-legible-timestamps.md). I’m looking at the web code now so I can say whether it’s worth fleshing out versus just treating it as a tiny direct fix.

There are already uncommitted note-file changes in the workspace, and this timestamp note itself is still untracked, so I’m avoiding anything that would overwrite your note scaffolding. I’m narrowing in on the actual web formatter usage under `apps/web` to gauge whether this is a small contained change or worth a fuller task entry.

This looks note-worthy rather than “just fix and move on”: the current formatter is centralized, but the change is user-facing across multiple pages and will likely need a small formatting decision plus test updates. I’m opening a couple of completed task notes now so I can mirror the house style and then I can flesh this one out instead of leaving it blank.

The implementation has one subtle wrinkle that makes tracking worthwhile: “user local time” in a server-rendered app can introduce hydration mismatches unless we decide where formatting happens. I’m checking the logs page render path before I write the note so that tradeoff is captured accurately rather than hand-waved.

I’m filling the task note now with the scope, the shared formatter impact, and the main SSR/local-time decision so it’s actionable instead of just a title stub.

The note file’s whitespace doesn’t match the template exactly, so the first patch missed. I’m reopening it with line numbers and then I’ll patch it surgically without disturbing the frontmatter you already have.

Yes. I fleshed it out in [task.2026.2026-03-15-legible-timestamps.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-15-legible-timestamps.md).

This is worth tracking because the current behavior comes from the shared formatter in [time.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/time.ts), so the change reaches more than one page. The note now captures the actual scope and the main design wrinkle: showing browser-local time in a server-rendered app without introducing timezone/hydration weirdness.

No tests run; this was a docs-only update.

# djradon_2026-03-15_1246_17

Yes, include Summary and all other surfaces now too. I think we can leave out the timezone abbreviation for now.

::capture-k

# djradon_2026-03-15_1246_17

Claude thinks "render stable fallback first, then replace on hydration."

# gpt-5.4_2026-03-15_1246_28

I’m updating the timestamp task note to lock in those choices: all current web timestamp surfaces are in scope, no timezone abbreviation in the visible text, and the SSR plan is “stable fallback first, then replace on hydration.”

# gpt-5.4_2026-03-15_1246_45

I’ve folded those decisions into the note. I’m doing one quick pass to make sure the resolved issues now read cleanly and that the scope is explicit everywhere it needs to be.

# gpt-5.4_2026-03-15_1246_48

I’m bumping the note’s `updated` timestamp so the metadata matches the edits, then I’ll hand you the finalized summary.

# gpt-5.4_2026-03-15_1246_52

I updated [task.2026.2026-03-15-legible-timestamps.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-15-legible-timestamps.md) to reflect those decisions.

It now treats all current web timestamp surfaces as in scope, records “no visible timezone abbreviation” as a decision, and adopts the SSR approach of rendering a stable fallback first and replacing it on hydration with browser-local time. The main open question left in the note is just what that pre-hydration fallback should be, and whether we preserve the canonical ISO value in a tooltip or `datetime` attribute.

No tests run; this was a note update only.

# djradon_2026-03-15_1257_53

Claude says "Default to undefined (UTC/ISO)", and I think that's fine. 

Go ahead an implement when you're satisfied that the task note is ready.

# gpt-5.4_2026-03-15_1258_03

I’m treating the note as ready and moving into implementation. First I’m mapping every current timestamp surface and the existing web formatting path so we can change it once in the right place instead of scattering local-time logic across components.

# gpt-5.4_2026-03-15_1258_07

I’ve confirmed the absolute timestamps all flow through one helper, and most of the affected pages are already islands. I’m checking the logs page render path next because it has both server-rendered and live-updated output, which is where the fallback/hydration strategy matters most.

# gpt-5.4_2026-03-15_1259_14

I’ve got a clean implementation path: one shared formatter update, one browser-timezone hook per live page, and a tiny reusable timestamp element so we can keep canonical ISO in the markup while showing local time after hydration. I’m opening the rest of the Summary and log code now so I can patch all surfaces in one pass.

# gpt-5.4_2026-03-15_1259_26

I’ve got the edit set lined up. I’m patching the shared time utilities plus the live pages together so the fallback and hydrated behavior stay consistent everywhere.

# gpt-5.4_2026-03-15_1300_11

The big patch tripped on import shapes, so I’m switching to smaller surgical edits. I’m reopening the exact file headers and then I’ll apply the implementation in smaller chunks to keep it safe alongside your existing workspace changes.

# gpt-5.4_2026-03-15_1301_13

The shared formatter and page-level wiring are in place. I’m doing a sweep now for any leftover direct timestamp calls or JSX spots that need cleanup before running tests.

# gpt-5.4_2026-03-15_1301_21

I spotted one subtle date-format edge case before verification: some `Intl` settings can render midnight as `24:00:00`. I’m tightening the formatter to 24-hour `00`-`23` output before running the checks.

# gpt-5.4_2026-03-15_1301_41

The formatter tests are green. I’m running a focused type check through the web app now so we catch any JSX or import breakage before I close this out.

# gpt-5.4_2026-03-15_1301_56

The code path is implemented and the focused checks passed, so I’m updating the task note to reflect the concrete decisions we actually shipped instead of leaving them as open questions.

# gpt-5.4_2026-03-15_1302_18

I finished the implementation and I’m doing one last pass over the note and the new helper files so the shipped behavior and the task record match cleanly.

# gpt-5.4_2026-03-15_1302_34

The type check is clean. I’m running a focused lint pass on the touched files now so we don’t leave any small freshness-rule or unused-import nits behind.

# gpt-5.4_2026-03-15_1303_14

I’m at the wrap-up stage now. I’m grabbing precise line references for the core helper, the reusable timestamp element, the browser-timezone hook, and the updated note/tests so the close-out points you to the right spots quickly.

# gpt-5.4_2026-03-15_1303_32

Implemented the web timestamp change across the current UI surfaces. [time.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/time.ts#L1) now keeps the stable server fallback as canonical ISO when no timezone is available, and formats as `YYYY-MM-DD HH:mm:ss` once a browser timezone is known. [use_browser_time_zone.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/islands/use_browser_time_zone.ts#L1) leaves that timezone `undefined` until hydration, and [TimestampText.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/TimestampText.tsx#L1) renders the visible text while preserving canonical ISO in both `datetime` and `title`. Sessions, Recordings, Maintenance, Workspaces, Summary, and Logs now use that shared path.

I also updated the task note at [task.2026.2026-03-15-legible-timestamps.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-03-15-legible-timestamps.md) to record the shipped decisions and mark the implementation steps complete, and expanded [web-time_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/web-time_test.ts#L1) to cover ISO fallback, browser-local formatting, and canonical normalization.

Verified with `deno test tests/web-time_test.ts`, `deno check main.ts client.ts routes/**/*.tsx src/**/*.ts islands/**/*.tsx islands/**/*.ts` from `apps/web`, and `deno lint` on the touched files. I didn’t run a manual browser pass.

# djradon_2026-03-15_1320_09

commit message plese

# gpt-5.4_2026-03-15_1320_13

`web: render timestamps in browser-local time with ISO fallback`

# djradon_2026-03-15_1321_34

detailed commit message.

# gpt-5.4_2026-03-15_1321_43

```text
web: render timestamps in browser-local time with ISO fallback

Replace the web app's machine-style ISO timestamp display with a friendlier
local format across all current timestamp surfaces, including Sessions,
Recordings, Maintenance, Logs, Summary, and Workspaces.

Keep server-rendered output stable by defaulting to canonical ISO until the
browser hydrates and can resolve the user's timezone. After hydration,
timestamps render as `YYYY-MM-DD HH:mm:ss` in the browser's local timezone,
without a timezone abbreviation.

Add a shared timestamp rendering path so the UI stays consistent:
- extend the web time helpers to support timezone-aware formatting
- add a reusable `TimestampText` component for visible text plus canonical
  `<time datetime>` / `title` metadata
- add a browser-timezone hook that leaves timezone undefined until hydration

Update timestamp tests to cover ISO fallback, local-time formatting, and
canonical normalization, and refresh the legible timestamps task note with the
decisions that shipped.
```