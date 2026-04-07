---
id: ynkw822oqlroa4f5xdmyh5i
title: 2026 03 11 Twins Follow Up
desc: ''
updated: 1773254078714
created: 1773238204946
---

# Goal

Resolve the confusing twin follow-up issues introduced by the ingestion/twin
split:

- twin state on the persisted-history surface should be derived from actual twin
  persistence, not from reused Sessions-page heuristics
- snippet display should be reconstituted when a twin already contains enough
  history to do so
- twin management should move out of top-level navigation and into
  `Maintenance`, where cleanup and troubleshooting already live

# Summary

- stop reusing `SessionIngestionAction` / `hasVisibleTwinHistory(...)` for the
  twin-management surface
- derive twin row state from the real persisted twin condition:
  - twin file present / absent
  - twin current / behind source
  - explicit maintenance actions available from that state
- replace passive `(no snippet)` placeholders with an explicit on-demand
  `show snippet` action where snippet recovery is possible
- reconstitute snippets lazily from twin/source history only when the operator
  explicitly asks to reveal them
- add the same snippet reveal behavior to `Sessions`, twin maintenance rows, and
  `Recordings`
- do **not** add a global startup snippet backfill pass
- move the current `Twins` page content onto `Maintenance`
- remove the top-level `Twins` route/tab after the maintenance replacement lands
- add a delete-twin affordance on each maintenance row as a trash-can action on
  the right side, below the state badge/status text

# Discussion

## Current Problems

- `loadTwinsPageData()` currently reuses `row.ingestionAction` from the Sessions
  loader, which means the twin-management surface can show contradictory state
  such as:
  - twin status `current`
  - action `create twin`
- the contradiction exists because:
  - twin status is derived from persisted metadata + source mtime
  - action state is derived from `hasVisibleTwinHistory(...)`, which mixes:
    - actual twin history
    - explicit historical activation markers
    - provider auto-twin policy
- snippet display on persisted-history surfaces currently comes only from
  `live?.snippet`, so persisted twins without a currently loaded snapshot show
  `(no snippet)` even though the twin file can usually provide one
- passive auto-rendering of recovered snippets is also not ideal for privacy:
  older session labels become casually visible even when the operator did not
  ask to inspect them
- the top-level `Twins` nav item is too prominent for a surface that is mainly
  useful for troubleshooting and cleanup

## Why Startup Backfill Is the Wrong Fix

We should not eagerly replay or scan every persisted session at daemon startup
just to repopulate snippets for web inventory pages.

That would:

- add unnecessary startup I/O and parsing work
- blur the line between runtime ingestion and durable twin metadata
- recreate a hidden background policy just to support a label in the UI

The better model is:

- live snapshot snippet when the daemon has already hydrated the session
- explicit `show snippet` action when a persisted twin or allowed
  source-replay path can recover the label on demand
- source replay only for flows that already need full history (`capture`,
  `export`, or explicit operator-triggered reveal/troubleshooting cases), not
  for a broad startup pass

## Scenario Table

| Scenario                                                                          | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes                                                                                 |
| --------------------------------------------------------------------------------- | ------------------ | ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| Twin file exists and source mtime is not newer                                    | Yes                | n/a                    | Yes            | Maintenance should show `current` and no `create twin` action                                                |
| Twin file exists and source mtime is newer                                        | Yes                | n/a                    | Yes            | Maintenance should show `behind source` and offer `update twin`                                              |
| Twin file is missing but metadata still has old twin counters                     | Yes                | n/a                    | Yes            | Treat as `no twin`; offer `create twin`; optionally heal/reset metadata                                      |
| Session has no live snapshot but twin file has history                            | Yes                | n/a                    | Yes            | Row should offer `show snippet`; recovery derives from twin history on demand                                |
| Session has no twin and no live snapshot                                          | n/a                | Yes                    | Yes            | Row may still end at `snippet unavailable` unless an explicit source-replay path is allowed there            |
| Recordings row has no live snippet but underlying session has recoverable history | Mixed              | Mixed                  | Yes            | Recordings should show snippet area and offer `show snippet` instead of permanently blank placeholder        |
| User wants to remove persisted twin history                                       | Yes                | n/a                    | n/a            | Maintenance row should offer trash/delete; metadata twin state resets without touching provider source files |
| User is browsing sessions for routine activity                                    | Mixed              | Mixed                  | No             | Sessions should focus on live activity / recording state, not top-level twin management                      |

# Open Issues

- No blocking open issues remain once the decisions below are treated as
  authoritative.
- Implementation detail to keep in mind:
  - even with immediate metadata rewrite after delete, loader-side healing
    should remain in place because crashes can still happen between file delete
    and metadata save.

# Decisions

- treat twin management as a maintenance/troubleshooting concern, not a
  primary-navigation concern
- remove the top-level `Twins` page/tab after its content is moved onto
  `Maintenance`
- keep `Sessions` focused on:
  - live activity
  - recording state
  - lightweight session inventory
- stop reusing `SessionIngestionAction` for persisted twin management
- replace the current hybrid visibility logic with explicit twin-maintenance
  state derived from:
  - actual twin-file presence
  - source freshness relative to persisted twin state
- do not reintroduce durable snippet persistence in metadata
- do not add a daemon-start global snippet reconstruction pass
- add a shared on-demand snippet-reveal flow for inventory surfaces
- default to not showing reconstructed snippets until the operator explicitly
  requests them for that row, then cache the revealed value so it can appear
  everywhere for that operator thereafter
- use user-facing wording:
  - `show snippet`
  - `loading snippet...`
  - `snippet unavailable`
- keep the Maintenance twin section live-polled like the other operational web
  inventories
- add a delete-twin maintenance action that:
  - removes the twin file
  - resets twin-specific metadata fields
  - preserves provider source path, ingest cursor, command cursor, and
    workspace recording state
- add a dedicated `Twin Cleanup` maintenance workflow that:
  - defaults to deleting old twin files while preserving metadata files
  - rewrites preserved metadata to canonical no-twin state
  - exposes an explicit operator opt-in to also delete twin metadata files when
    stronger privacy cleanup is needed
- use direct inline twin deletion from Maintenance without a separate
  confirmation flow; twin history is reconstructible in the common case and
  provider source files remain untouched
- rewrite metadata immediately after delete to canonical no-twin state so the
  persisted store converges quickly even if the daemon stops soon after
- keep loader/view-model healing for missing-twin/stale-metadata cases as a
  fail-safe, even though delete should rewrite metadata immediately

# Contract Changes

- web route/navigation surface
  - remove `/twins` as a top-level page once Maintenance carries the twin UI
  - remove `/api/twins` if no longer needed after the move
- web loader/view-model surface
  - replace `TwinActivityRow.twinAction` reuse from Sessions with a dedicated
    maintenance twin action model
  - add snippet reveal state/results for Sessions, Recordings, and maintenance
    twin rows
- web mutation/API surface
  - add an explicit snippet-reveal action or endpoint instead of passive
    snippet fallback during page load
- runtime/session-state surface
  - add a dedicated helper for clearing twin persistence state from
    `SessionMetadataV1` without dropping non-twin session metadata

# Testing

- web loader tests for:
  - twin row action/state consistency:
    - `current` => no create action
    - `behind` => `update twin`
    - `absent` => `create twin`
  - missing twin file + stale metadata healing behavior
- snippet reveal tests for:
  - Sessions row reveal derives snippet from twin history when no live snapshot
    exists
  - Maintenance twin row reveal derives snippet from twin history on demand
  - Recordings row shows snippet area and can reveal snippet on demand
  - initial reveal is row-scoped, but once revealed the snippet can appear
    elsewhere for that operator without another prompt
  - placeholder remains when no permitted reveal source exists
- maintenance route tests for:
  - twin rows render under Maintenance with expected labels and filters
  - delete-twin removes the twin file and resets twin-only metadata state
  - provider source files remain untouched by delete-twin
  - reveal snippet action coexists cleanly with twin create/update/delete actions
- sessions page tests for:
  - twin-management controls removed or reduced to the intended lightweight
    affordance
  - live activity / recordings remain intact after twin UI removal
  - snippet reveal affordance appears only when recovery is possible
- recordings page tests for:
  - recording rows include snippet display area
  - snippet reveal uses the shared on-demand path
  - recording navigation/state filters remain unchanged
- runtime/session-state tests for:
  - metadata reset helper preserves cursors, command state, and workspace
    outputs while clearing twin persistence fields
- route/API tests for:
  - reveal snippet action returns the expected row/session snippet payload
  - reveal does not mutate durable metadata snippets because none are persisted

# Non-Goals

- do not persist snippets back into `SessionMetadataV1`
- do not add a startup task that reparses every session solely to fill snippet
  labels
- do not auto-reveal reconstructed snippets for all old sessions during ordinary
  page load
- do not preserve `/twins` as a compatibility alias once Maintenance replaces it
- do not change provider-source replay policy for `capture` / `export` in this
  follow-up unless required by the snippet helper extraction

# Implementation Plan

## 1. Untangle Twin State Semantics

- [x] introduce a dedicated twin-maintenance row model instead of reusing
      Sessions-page action state
- [x] remove or rename misleading helpers such as
      `hasVisibleTwinHistory(...)` where they are no longer the right abstraction
- [x] derive maintenance twin state from actual persisted twin condition:
  - twin file presence
  - metadata twin counters
  - source-file freshness
- [x] treat missing twin files with stale metadata as `no twin` rather than as
      a separately visible pseudo-state unless debugging proves otherwise

## 2. Snippet Reconstitution

- [x] add a shared snippet-reveal helper that resolves a session snippet in
      this order:
  - live snapshot snippet
  - twin-derived snippet
  - explicit source-replay snippet only where the route intentionally opts in
  - placeholder text otherwise
- [x] add row-level `show snippet` affordances instead of passive fallback on:
  - `Sessions`
  - maintenance twin rows
  - `Recordings`
- [x] use that helper for the maintenance twin surface so existing twins no
      longer stay at `(no snippet)` when the operator explicitly asks to reveal them
- [x] add snippet display support to `Recordings` rows, using the same
      on-demand reveal path rather than a separate snippet model
- [x] keep startup behavior lazy:
  - no eager full-session replay pass
  - no background snippet-only hydration job

## 3. Twin Delete / Reset Flow

- [x] add a runtime/session-state helper for clearing twin persistence state
      from metadata while preserving non-twin session continuity
- [x] implement a maintenance POST action to delete a single twin
- [x] implement direct inline delete with no extra confirmation flow
- [x] ensure delete-twin removes:
  - the twin file
  - `nextTwinSeq`
  - recent fingerprint state
  - explicit twin-activation markers that no longer make sense without a twin
- [x] rewrite metadata immediately after delete to canonical no-twin state
- [x] ensure delete-twin does **not** remove:
  - provider source files
  - ingest cursor continuity
  - command cursor continuity
  - workspace output / recording bindings

## 4. Move Twin UI Into Maintenance

- [x] add a Maintenance section for persisted twin inventory and troubleshooting
- [x] move current twin row content into that section:
  - snippet
  - provider/session id
  - twin path
  - source path
  - state (`current`, `behind source`, `no twin`)
  - action (`create twin`, `update twin`)
- [x] place a trash-can delete affordance on the right side of each row, below
      the status text
- [x] use direct inline delete with no confirmation dialog or second-step form
- [x] remove the top-level `Twins` nav item, route, and route-specific loader
      once the Maintenance section fully replaces it

## 5. Simplify Sessions

- [x] remove twin-management-specific presentation from `Sessions` if it is no
      longer needed after the Maintenance move
- [x] keep Sessions anchored around:
  - live activity
  - recording engagement
  - session inventory
- [x] keep snippet display privacy-preserving by showing recovered snippets only
      after an explicit row-level reveal action, then allow the revealed snippet to
      appear elsewhere for that operator
- [x] update Summary / Workspaces / Recordings backlinks so they point to
      `Sessions` for routine session navigation and to `Maintenance` only for
      explicit twin troubleshooting/cleanup flows

## 6. Documentation

- [x] update this note as the follow-up decisions land
- [x] update `dev.codebase-overview`
- [x] update `dev.decision-log`
- [x] update `dev.general-guidance` if the route/navigation guidance changes

## Coderabbit review

Worth keeping from PR #23 review:

- [x] wrap persisted-history loading inside daemon-runtime snapshot fallback so
  `loadSessionSnapshot(...)` degrades to the live snapshot instead of failing
  export/control flows when replay loading throws
  ([CodeRabbit](https://github.com/spectacular-voyage/kato/pull/23#discussion_r2919465340))
- [x] stop forcing `twinExists = true` after provider bootstrap when no twin
  events were actually appended; derive hydration eligibility from real twin
  evidence instead
  ([CodeRabbit](https://github.com/spectacular-voyage/kato/pull/23#discussion_r2919465376))
- [x] tighten provider-ingestion hydration gating so `!currentSnapshot` alone
  does not trigger hydration unless there is at least one real source to
  hydrate from
  ([CodeRabbit review summary](https://github.com/spectacular-voyage/kato/pull/23#pullrequestreview-3930820676))
- [x] reject negative cleanup retention values in runtime cleanup entrypoints
  (`twinsDays`, and likely `recordingsDays` for symmetry) before any
  destructive older-than computation runs
  ([CodeRabbit](https://github.com/spectacular-voyage/kato/pull/23#discussion_r2919465406))
- [x] treat empty `twinsDays` form/query values as invalid/default in the web
  maintenance surface rather than coercing them to `0`
  ([CodeRabbit](https://github.com/spectacular-voyage/kato/pull/23#discussion_r2919465418))
- [x] degrade snippet resolution to `status: "unavailable"` when twin reads or
  persisted-history replay throws, instead of bubbling an API error to the web
  client
  ([CodeRabbit](https://github.com/spectacular-voyage/kato/pull/23#discussion_r2919465429))
- [x] fix Summary wording so live-but-not-generating sessions are described as
  `not generating` / `not persisting`, not `inactive`, and avoid saying
  `No provider sessions are currently active.` when sessions are live but not
  generating twins
  ([CodeRabbit review summary](https://github.com/spectacular-voyage/kato/pull/23#pullrequestreview-3930820676))
- [x] preserve `includeStale` and `workspaceFilter` when posting Maintenance log
  actions so log truncation does not reset the current twin-view filters
  ([CodeRabbit review summary](https://github.com/spectacular-voyage/kato/pull/23#pullrequestreview-3930820676))
- [x] move `session_snippets.ts` off direct `apps/daemon/src/...` imports by
  exposing the needed replay/twin mapping helpers through `@kato/runtime` (or
  another shared boundary)
  ([CodeRabbit review summary](https://github.com/spectacular-voyage/kato/pull/23#pullrequestreview-3930820676))

Intentionally not tracked here:

- backwards-compatibility / migration suggestions for legacy snapshot config
  keys, because this task explicitly prefers clean breaks over compatibility
  aliases
- delete-confirmation suggestions for twin removal, because this task
  explicitly chose direct inline delete with no confirmation step
