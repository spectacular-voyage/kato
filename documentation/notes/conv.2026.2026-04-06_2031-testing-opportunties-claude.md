---
id: testing-opportunties-cac816b2
title: 'testing opportunties'
desc: ''
created: 1775532709430
updated: 1775532709430
participants: [djradon, claude.claude-sonnet-4-6]
kato-sessionIds: [840312cc-cbc0-4376-9394-8e6af26f6fed]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [cac816b2-4570-4ca8-ab28-666c4007797d]
conversationEventKinds: [message.assistant, message.user, thinking, tool.call, tool.result]
---

# djradon_2026-04-06_2026_21

testing opportunties

Please identify any obvious gaps in testing. Check the codecov reports if that helps

The user wants me to identify obvious gaps in testing for the Kato project. Let me look at the codebase structure first, and check for any codecov reports.

This is a very thorough analysis. Let me summarize the key findings for the user in a concise way.

# claude-sonnet-4.6_2026-04-06_2031_25

Here's a summary of the most actionable testing gaps:

## Testing Coverage Overview: 80.8% (22,466 / 27,813 lines)

### Critical Gaps

**1. Shared contracts (57% line coverage) — highest value**
- `shared/src/contracts/config.ts`, `events.ts`, `status.ts`, `ipc.ts`, `messages.ts`, `aggregation.ts`
- These define core IPC/messaging schemas but lack runtime serialization/deserialization tests

**2. Web API routes (0% coverage) — 8 routes**
- All of [apps/web/routes/api/](apps/web/routes/api/) is untested: `logs.ts`, `sessions.ts`, `recordings.ts`, `workspaces.ts`, `summary.ts`, etc.
- These are thin Fresh handlers over tested loaders, so integration tests would be relatively quick to write

**3. Web islands (0% coverage) — 10 components**
- All real-time polling islands (`SessionsLive`, `LogsResultsLive`, `RecordingsLive`, etc.)
- `use_polled_json.ts` and `use_browser_time_zone.ts` hooks are completely untested

### Well-Tested Areas (no action needed)
- Daemon: 97% file coverage
- Runtime: 97% file coverage
- CLI: 88% file coverage
- Web loaders/business logic: mostly covered

### Quick Wins (Priority Order)
1. **Shared contract tests** — pure unit tests, no framework complexity, ~325 lines of contract code to cover
2. **Web API route tests** — mock the loaders, verify response shapes, ~8 test cases
3. **`use_polled_json` hook** — testable with mocked `fetch`, high reuse across all islands

The coverage report is at [coverage.lcov](coverage.lcov) (507 KB). The `.codecov.yml` only requires 80% patch coverage for PRs, so you're already meeting the bar — but the shared contracts gap is a real reliability risk given how central IPC/messaging is to the system.
