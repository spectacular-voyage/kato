---
id: xku063mo40s8wvi93qdakp0
title: 2026 03 10 Dynamic Updates Everywhere
desc: ''
updated: 1773183263244
created: 1773179256688
---
## Goal

Add consistent live updating across the current Kato Web route set so operator
state stays fresh without whole-page reloads, covering the shared
`DAEMON` / `SNAPSHOT` header status plus the body regions for the current
route-backed pages that expose live-ish operational data.

## Summary

- Current shipped baseline:
  - `Summary` already polls via `SummaryLive` and `/api/summary`.
  - all other authenticated pages are still server-rendered and compute
    `appStatus` only once per request.
  - the current route map is:
    - `/` Summary
    - `/ingestion`
    - `/sessions`
    - `/recordings`
    - `/workspaces`
    - `/logs`
    - `/settings`
    - `/maintenance`
- Keep server-rendered first paint plus Fresh islands.
- Add small reusable live surfaces:
  - one shared live header-status island
  - one live body island per page that truly benefits from background refresh
- Preserve `POST` / redirect / `GET` mutation flows. Do not convert workspace,
  settings, maintenance, or manual-ingestion actions into AJAX mutations.
- Use app-owned JSON endpoints with `no-store` cache headers and full-model
  payloads. Do not introduce SSE, websockets, or diff streams in this pass.
- Keep query-driven filtering canonical. Live polling should follow the URL that
  is already expressing the current page state.

## Discussion

This note was created before the final evening route split, so several old
assumptions are now wrong:

- there are no separate `/operational` and `/security` pages any more; both were
  consolidated into `/logs`
- `/sessions` is now inventory-only
- operational ingest state lives on `/ingestion`
- `/recordings` is now a first-class route
- only `/api/summary` has shipped so far

Current behavior is therefore uneven:

- `Summary` already has a polling island and JSON endpoint.
- `Ingestion`, `Sessions`, `Recordings`, `Workspaces`, and `Logs` are still
  plain server-rendered pages.
- the shared header status is only truly live on `Summary`, because the Summary
  island owns the header while other pages render `appStatus` once on the
  server.

The implementation shape to lock in is:

- keep `AppHeader` mostly server-rendered, but move the live
  `DAEMON` / `SNAPSHOT` stack into a reusable header-status island
- keep one body poller per live page instead of one poller per card/list, so
  each page stays internally consistent
- accept separate header polling and body polling on pages that have both
- keep mutation notices and forms outside live regions on pages where background
  polling would otherwise wipe user input or success/error banners
- preserve current query semantics exactly for:
  - `/ingestion`: `view=active`, `workspace`
  - `/sessions`: `view=active`, `workspace`
  - `/recordings`: `view=active`, `workspace`, `state`
  - `/logs`: `channel`, `scope`, `level`, `event`, `q`

Page-specific constraints:

- `Summary` can keep its existing full-body island and `/api/summary` endpoint.
- `Ingestion` should refresh counts and rows without losing the current anchor
  and workspace filter.
- `Sessions` should refresh the inventory summary and rows without wiping
  `start ingestion` / `continue ingestion` notices after a redirect.
- `Recordings` should refresh the filtered list and count summary in place.
- `Workspaces` should refresh registered-workspace rows and write-root coverage
  while leaving register/unregister notices and form inputs alone.
- `Logs` should not clobber in-progress filter text entry. The safer shape is to
  keep the filter shell static and make only the count + result list live.

## Open Issues

- No blocking design issue remains, but the actual route inventory changed after
  this note was created.
- Follow-up only: whether to later collapse separate header/body polling into a
  shared transport.
- Follow-up only: whether to later add hidden-tab throttling or SSE if `2s`
  polling proves noisier than expected.

## Decisions

- `2s` polling cadence is fixed everywhere in this task.
- Small islands means:
  - one shared live header-status island
  - one live body island per page
  - not one independent polling island per Summary tile or per list/card
- `Summary` keeps its existing full-page-model live endpoint and one body island
  that owns:
  - Daemon tile
  - Activity tiles
  - Providers
  - Active Ingestion
  - Workspaces
  - Recent Errors
- `Ingestion` gets a dedicated live endpoint and one body island that owns:
  - the page summary bar
  - the filtered ingest activity list
- `Sessions` gets a dedicated live endpoint and one body island that owns:
  - the page summary bar
  - the filtered inventory list
- `Recordings` gets a dedicated live endpoint and one body island that owns:
  - the page summary bar
  - the filtered recording list
- `Workspaces` gets a dedicated live endpoint/body island for:
  - Write Root Coverage
  - Registered Workspaces
- `Logs` gets a dedicated live endpoint/body island for:
  - filtered result count
  - filtered log entry list
- `Workspaces` register/unregister remains `POST` / redirect / `GET`.
- `Settings` and `Maintenance` get live header status only; their page bodies
  remain static in this task.
- `Login` remains static.
- Do not add hidden-tab pause/resume logic or per-poll error UI in this pass;
  live islands keep the last good render if a poll fails.

## Contract Changes

- Add `/api/chrome-status` returning the existing `AppChromeStatus` model from
  `loadAppChromeStatus()`.
- Keep `/api/summary` returning the existing `SummaryPageData` model from
  `loadSummaryPageData()`.
- Add `/api/ingestion` returning the existing `SessionsPageData` model from
  `loadSessionsPageData()`.
- `/api/ingestion` must preserve current page query semantics exactly:
  - `view=active` means active-only
  - absence of `view=active` means include stale
  - `workspace=<workspaceId>` filters to sessions linked to that workspace
- Add `/api/sessions` returning the existing `SessionsPageData` model from
  `loadSessionsPageData()`.
- `/api/sessions` must preserve current page query semantics exactly:
  - `view=active` means active-only
  - absence of `view=active` means include stale
  - `workspace=<workspaceId>` filters to sessions linked to that workspace
- Add `/api/recordings` returning the existing `RecordingsPageData` model from
  `loadRecordingsPageData()`.
- `/api/recordings` must preserve current page query semantics exactly:
  - `view=active` means active-only
  - absence of `view=active` means include stale
  - `workspace=<workspaceId>` filters to recordings linked to that workspace
  - `state=<filter>` preserves the existing state-filter semantics
- Add `/api/workspaces` returning the existing `WorkspacesPageData` model from
  `loadWorkspacesPageData()`.
- Add `/api/logs` returning the existing `LogPageData` model from
  `loadLogPageData()`.
- `/api/logs` must preserve current query semantics exactly:
  - `channel=<filter>`
  - `scope=<filter>`
  - `level=<filter>`
  - `event=<substring>`
  - `q=<substring>`
- Add a shared no-store JSON response helper used by all live endpoints.
- Add a shared client polling utility with these fixed behaviors:
  - takes `initialData`, endpoint URL, and interval
  - fetches immediately on mount
  - uses `cache: "no-store"`
  - prevents overlapping requests
  - preserves last good data on request failure

## Testing

Implementation should add or validate all of the following:

- route tests for `no-store` cache headers on:
  - `/api/chrome-status`
  - `/api/summary`
  - `/api/ingestion`
  - `/api/sessions`
  - `/api/recordings`
  - `/api/workspaces`
  - `/api/logs`
- route tests for query behavior on:
  - `/api/ingestion`
  - `/api/sessions`
  - `/api/recordings`
  - `/api/logs`
- route tests for `/api/sessions` query behavior should specifically cover:
  - `view=active`
  - `workspace=<workspaceId>`
  - combined filter behavior
- existing loader tests remain the primary data-contract checks:
  - `tests/web-summary-loader_test.ts`
  - `tests/web-activity-loader_test.ts`
  - `tests/web-log-loader_test.ts`
- do not introduce a new browser/component test harness in this task
- manual acceptance checks:
  - `Summary` updates header status, heartbeat, memory RSS, providers,
    active-ingestion rows, and workspace summary within `2s` without flashing
    the page
  - `Ingestion` updates counts and rows within `2s` without losing current
    query filters or session anchors
  - `Sessions` updates counts and inventory rows within `2s` without losing
    current query filters
  - `Recordings` updates counts and filtered rows within `2s`
  - `Workspaces` updates coverage and workspace rows within `2s`, while
    register/unregister notices still arrive via redirect and remain visible
  - `Logs` updates the result count and matching rows within `2s` without
    clobbering filter controls in progress
  - `Settings` and `Maintenance` show live header status without changing
    page-body behavior
- implementation validation should include:
  - `deno task test`
  - `deno task check`
  - `deno task lint` if the refactor broadens shared frontend structure

## Non-Goals

- Do not add full-page auto-refresh or meta-refresh.
- Do not convert `Workspaces` mutations to AJAX or optimistic UI.
- Do not add SSE, websockets, filesystem watch push, or diff-based endpoint
  payloads.
- Do not make `Settings` or `Maintenance` page bodies live in this task.
- Do not break or replace current URL-driven filtering on `Ingestion`,
  `Sessions`, `Recordings`, or `Logs`.
- Do not try to deduplicate all polling into one global client store in this
  pass.

## Implementation Plan

- [x] Refactor the shared header so the live `DAEMON` / `SNAPSHOT` stack becomes
      a reusable header-status island without hydrating the entire page chrome.
- [x] Add a shared client polling utility and a shared no-store JSON response
      helper for all live endpoints.
- [x] Add `/api/chrome-status` and cover it with route/header-cache tests.
- [x] Ship Summary body polling via `/api/summary` and `SummaryLive`.
- [x] Split the Summary page so the header status polls separately while the
      existing Summary body island continues to own Daemon, Activity, Providers,
      Active Ingestion, Workspaces, and Recent Errors.
- [x] Add `/api/ingestion` and an `Ingestion` body island that preserves current
      query filtering and updates the summary bar plus ingest rows.
- [x] Add `/api/sessions` and a `Sessions` body island that preserves current
      query filtering and updates the summary bar plus inventory rows.
- [x] Add `/api/recordings` and a `Recordings` body island that preserves
      current query filtering and updates the summary bar plus recording rows.
- [x] Add `/api/workspaces` and a `Workspaces` body island that updates Write
      Root Coverage plus Registered Workspaces while leaving forms and notices
      outside the live region.
- [x] Add `/api/logs` and a `Logs` body island that updates the filtered count
      and rows while keeping the filter shell stable.
- [x] Wire the shared live header-status island into all authenticated pages
      that already show `appStatus`: `Ingestion`, `Sessions`, `Recordings`,
      `Workspaces`, `Logs`, `Settings`, and `Maintenance`.
- [x] Add focused route tests for the new live endpoints and keep existing
      loader tests as the source of truth for page-data correctness.
- [x] Run the targeted implementation validation for logic and contract changes,
      then do manual browser verification of Summary, Ingestion, Sessions,
      Recordings, Workspaces, Logs, and header-status behavior across
      authenticated pages.
