---
id: contract-testing-cbb4d605
title: 'contract testing'
desc: ''
created: 1773523102764
updated: 1773523102764
participants: [codex.gpt-5.4]
kato-sessionIds: [019cee33-e17c-7e93-8f85-ed7e27dbcfb0]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [cbb4d605-3b14-40e4-a663-be92e5b2fd73]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# User_2026-03-14_1417_46

contract testing

Are there opportunies to increase coverage with valuable tests on session_state.ts and session_twin.ts>

# gpt-5.4_2026-03-14_1417_55

I’m looking through `session_state.ts` and `session_twin.ts` alongside their existing tests first, so we can separate genuine contract gaps from low-value coverage padding.

I found the contract files and the existing neighboring tests. Next I’m reading the validator logic and looking for whether those branches are already exercised indirectly through store/mapper tests.

# User_2026-03-14_1418_22

ignore:

::capture-k

# gpt-5.4_2026-03-14_1418_33

I’m treating `::capture-k` as noise and ignoring it. I’ve got the contract validators open now, and I’m checking whether any uncovered branches correspond to meaningful schema guarantees rather than just “reject wrong type” boilerplate.

# gpt-5.4_2026-03-14_1418_43

I haven’t seen any direct validator tests yet, which usually means these files are only covered as side-effects of store/mapper tests. I’m pulling the test task config next so I can do a focused coverage run instead of guessing at blind spots.

# gpt-5.4_2026-03-14_1422_26

Yes. The good opportunities are in the exported validators, not in the type-only parts.

- Highest value: add direct table-driven tests for `isSessionMetadataV1()` in [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts#L289). The current persistence tests in [session-state-store_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-state-store_test.ts) cover happy-path read/write, but they do not really pin several schema branches: `commandCursorAnchor`, `ingestAnchor`, full `writerFeatureFlags`, `absolute-explicit` destinations, and stopped recording-cycle fields. One “maximal valid metadata” fixture plus a few invalid nested fixtures would be high-signal.
- Next: add direct tests for `isDaemonControlIndexV1()` in [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts#L424). That validator decides whether [session_state_store.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/orchestrator/session_state_store.ts#L592) trusts `daemon-control.json` or rebuilds it, so malformed-entry tests are meaningful behavior coverage.
- Also valuable: add direct tests for `isSessionTwinEventV1()` and `isSessionTwinKind()` in [session_twin.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_twin.ts#L87). The existing mapper tests in [session-twin-mapper_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-twin-mapper_test.ts) cover lots of happy-path shapes, but they do not directly pin rejection of bad `seq`, bad `emitIndex`, unknown `kind`, non-record `time`, or array `payload`. That matters because [session_state_store.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/runtime/src/orchestrator/session_state_store.ts#L543) silently skips invalid twin lines based on this validator.

What I would not do is add one test per tiny helper or every trivial `typeof` branch. A small `tests/session-contracts_test.ts` with table-driven valid/invalid fixtures would get the value without padding.

One caution: [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts#L181) currently allows a `"workspace-relative"` destination without `relativePathFromWorkspaceRoot`, and [session_twin.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_twin.ts#L132) allows empty-string `providerEventId`/timestamps. I’d decide whether that permissiveness is intentional before writing acceptance tests, so we don’t lock in a bug.

I couldn’t get a fresh focused coverage number because `deno test --coverage` hit a Deno 2.7.5 Windows pipe panic here, so this is based on source and existing-test inspection rather than a new coverage report.

# User_2026-03-14_1430_04

Try again, I just granted "Full access".

Help me solve the workspace-relative destination and empty-string providerEventId questions.

# gpt-5.4_2026-03-14_1430_14

I’m tracing both fields through the codebase now so we can decide from actual behavior, not just the validator surface. After that I’ll either tighten the contracts and add tests, or explain why the permissive shape is intentional.

# gpt-5.4_2026-03-14_1430_30

I’ve got the call sites. Next I’m reading the destination and event-id logic where these values are actually produced and consumed, because that will tell us whether the contract should be stricter or stay loose.

# gpt-5.4_2026-03-14_1433_05

I’m at the decision point now. `providerEventId` is looking like canonical noise we can safely tighten away, while the destination path field is more subtle because the rest of the runtime can recover without it. I’m checking the last few consumers of `absolutePath` and `relativePathFromWorkspaceRoot` before I recommend a concrete contract.

# gpt-5.4_2026-03-14_1433_18

I’ve got a pretty clear split now: `providerEventId` behaves like canonical data and should probably be normalized tighter, while destination path fragments behave more like recoverable hints. I’m checking the current worktree before I patch anything so I don’t step on unrelated work.

# gpt-5.4_2026-03-14_1434_25

I’m making a small patch that encodes the decision instead of leaving it implicit: keep destination path hints tolerant in `session_state.ts`, tighten empty-string twin metadata in `session_twin.ts`, and add focused contract tests so the decision is locked in.

# gpt-5.4_2026-03-14_1435_07

The patch is in. I’m formatting and running the focused contract tests now so we can tell whether the stricter twin rule and the tolerant destination rule both hold up in practice.

# gpt-5.4_2026-03-14_1435_22

The focused contract suite is green. I’m running the neighboring state-store and twin-mapper tests too, just to make sure the stricter twin validation didn’t create an integration regression.

# gpt-5.4_2026-03-14_1435_42

The neighboring suites are green too. I’m doing one last pass over the worktree so I can give you a crisp recommendation and point to the exact patch/test that now encodes it.

# gpt-5.4_2026-03-14_1436_17

Made the call in code.

- `workspace-relative` and `absolute-explicit` destination path fields stay optional in [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts#L22). I added a comment plus direct tests in [session-contracts_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-contracts_test.ts#L45) to lock in the intended meaning: those fields are path hints, while `kind` plus `currentResolvedPath` carry the real semantics. I did not tighten that validator, because the runtime can recover without the hint and rejecting the whole metadata record would be harsher than the value it adds.
- Empty-string twin metadata is now rejected in [session_twin.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_twin.ts#L132). If `providerEventId`, `providerTimestamp`, `capturedAt`, `turnId`, or `model` don’t have a real value, they should be omitted instead of serialized as `""` or whitespace. That matches the existing mapper/runtime behavior, which already treats empty strings as “not present.”
- The new focused tests in [session-contracts_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-contracts_test.ts#L45) cover both decisions directly.

Verification is green: `tests/session-contracts_test.ts`, [session-state-store_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-state-store_test.ts), and [session-twin-mapper_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-twin-mapper_test.ts) all passed, with `17` passing tests and `1` existing ignored Windows legacy-key case.

# User_2026-03-14_1439_25

Are you sure about providerTimestamp? Codex doesn't provide timestamps, but this wouldn't affect the "codex timestamps get generated if ingestion is in realtime"?

# gpt-5.4_2026-03-14_1439_40

I’m verifying the exact Codex timestamp path before answering, because the important distinction here is whether we ever store those as `providerTimestamp` versus `capturedAt` or plain event timestamps.

# gpt-5.4_2026-03-14_1439_57

I found the relevant split. I’m opening the Codex parser and the ingestion/twin tests now so I can answer with the exact field flow instead of hand-waving.

# gpt-5.4_2026-03-14_1440_23

Yes, I’m comfortable with it, and the key distinction is:

- Codex realtime synthetic timestamps exist first as `ConversationEvent.timestamp` in the parser, in [codex/parser.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/providers/codex/parser.ts#L209).
- They are not persisted as `time.providerTimestamp` in twins. `mapConversationEventsToTwin()` explicitly suppresses `providerTimestamp` for all Codex events in [session_twin_mapper.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/session_twin_mapper.ts#L24).
- For live ingestion, the daemon instead writes `capturedAt: nowIso` in [provider_ingestion.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts#L1431) and the web path does the same in [session_ingestion.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/web/src/session_ingestion.ts#L147).
- When twins are read back, timestamp reconstruction prefers `providerTimestamp` but falls back to `capturedAt` in [session_twin_mapper.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/session_twin_mapper.ts#L301).

So tightening `providerTimestamp` to reject `""` does not break “Codex realtime gets generated timestamps.” That behavior is currently preserved through `capturedAt`, not through `providerTimestamp`.

The tests line up with that:
- Codex retrospective parse omits timestamps: [codex-parser_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/codex-parser_test.ts#L183)
- Codex incremental parse generates timestamps on events: [codex-parser_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/codex-parser_test.ts#L192)
- Codex twins omit `providerTimestamp` by policy: [session-twin-mapper_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-twin-mapper_test.ts#L70)
- `capturedAt` round-trips back into the event timestamp: [session-twin-mapper_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-twin-mapper_test.ts#L122)

One nuance: if you want Codex live timestamps to be semantically treated as “provider-ish event times” rather than “capture times,” that would be a mapper policy change. But the validator change I made does not alter the current behavior.

# User_2026-03-14_1454_32

The realtime timestamps don't get written to the twins? I think they do.

# gpt-5.4_2026-03-14_1454_50

I’m checking the exact Codex live path with a concrete local run, because the subtlety is whether the twin stores the parser’s synthetic timestamp as `providerTimestamp` or stores a fresh ingestion-time `capturedAt` instead.

# gpt-5.4_2026-03-14_1455_14

The precise answer is: Codex live timestamps do make it into the twin history, but not as `time.providerTimestamp`.

- `parseCodexEvents()` generates a synthetic `event.timestamp` for incremental reads in [parser.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/providers/codex/parser.ts#L209).
- `mapConversationEventsToTwin()` then explicitly suppresses `providerTimestamp` for all Codex events in [session_twin_mapper.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/session_twin_mapper.ts#L24).
- Live ingestion still writes a twin time via `capturedAt` in [provider_ingestion.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts#L1431) and [session_ingestion.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/web/src/session_ingestion.ts#L147).

I verified that locally with a Codex fixture: the parsed event had a synthetic `timestamp`, and the resulting twin had `time: { capturedAt: ... }` with no `providerTimestamp`. So my earlier wording was too loose. The twin does get a time for Codex realtime ingestion; it just lands in `capturedAt`, not `providerTimestamp`. That means the validator change on empty-string `providerTimestamp` still does not affect the current Codex live behavior.

# User_2026-03-14_1459_07

Claude identified One minor gap: the "rejects blank path hints" test only covers relativePathFromWorkspaceRoot: "   " on a workspace-relative destination. The symmetric case (absolutePath: "   " on absolute-explicit) isn't tested. The validator code does cover it (session_state.ts:201-206), but there's no test pinning it. Low priority — worth noting if you want full symmetry.

Is that worth addressing?

# gpt-5.4_2026-03-14_1459_27

Yes, but only as cheap polish.

I wouldn’t call it an important gap, because the branch in [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts#L201) is simple and the runtime constructors already produce real absolute paths. So this is not a likely bug source.

That said, in a small contract suite like [session-contracts_test.ts](c:/Users/drich/hub/spectacular-voyage/kato/tests/session-contracts_test.ts#L94), symmetry is nice. I’d add it if we’re already touching the file, but I wouldn’t make a separate follow-up just for that. Best shape would be to extend the existing “rejects blank path hints” test into a tiny two-case table:
- `workspace-relative` + blank `relativePathFromWorkspaceRoot`
- `absolute-explicit` + blank `absolutePath`

So: worth addressing opportunistically, not worth prioritizing.

# User_2026-03-14_1501_04

How's our codecov look?

# gpt-5.4_2026-03-14_1501_18

I’m checking the repo’s current coverage state directly so I can answer with real numbers, not the older review notes. After that I’ll translate it back to what it likely means for Codecov versus local Deno coverage.

# gpt-5.4_2026-03-14_1502_35

I’ve got a fresh full coverage run. I’m pulling the report header and Codecov config next so I can translate those Deno numbers into the “what does Codecov likely show us?” version, not just dump raw percentages.

# gpt-5.4_2026-03-14_1503_08

Fresh local proxy for Codecov looks like this:

- Overall: `85.2%` branch, `93.0%` function, `78.1%` line from `deno task test:coverage --frozen --quiet`
- Codecov policy in [.codecov.yml](c:/Users/drich/hub/spectacular-voyage/kato/.codecov.yml) is `project: target auto, threshold 1%` and `patch: target 80%`

For the two contract files we were just discussing:

- [session_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_state.ts): `79.5%` branch, `100.0%` function, `30.1%` line
- [session_twin.ts](c:/Users/drich/hub/spectacular-voyage/kato/shared/src/contracts/session_twin.ts): `78.7%` branch, `100.0%` function, `57.8%` line

A few notable lower-line-coverage hotspots from the current run:

- [provider_ingestion.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts): `68.0%`
- [activity_state.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/web/src/activity_state.ts): `38.1%`
- [workspaces.ts](c:/Users/drich/hub/spectacular-voyage/kato/apps/web/src/loaders/workspaces.ts): `66.9%`

So the short version is: Codecov should be looking materially better than the older mid-70s repo number once this coverage upload lands, with project line coverage around `78.1%` based on the current tree.