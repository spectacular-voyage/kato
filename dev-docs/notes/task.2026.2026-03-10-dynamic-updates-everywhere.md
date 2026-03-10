---
id: xku063mo40s8wvi93qdakp0
title: 2026 03 10 Dynamic Updates Everywhere
desc: ''
updated: 1773183263244
created: 1773179256688
---
## Goal

Add consistent live updating across Kato Web's operator-facing pages so current
status stays fresh without whole-page reloads, covering the Summary body,
Sessions page, Workspaces page, and the shared `DAEMON` / `SNAPSHOT` header
status on authenticated pages.

## Summary

- Keep the current server-rendered first paint plus Fresh islands model.
- Use small reusable live surfaces:
  - one shared live header-status island
  - one live page-body island for `Summary`
  - one live page-body island for `Sessions`
  - one live page-body island for `Workspaces`
- Poll every `2s` everywhere in this task.
- Preserve `POST` / redirect / `GET` mutation flows on `Workspaces`; do not
  convert register/unregister to AJAX mutations.
- Use app-owned JSON endpoints with `no-store` cache headers and full-model
  payloads; do not introduce SSE, websockets, or diff streams in this pass.

## Discussion

Current behavior is uneven:

- `Summary` already has a polling island and JSON endpoint, but `Sessions` and
  `Workspaces` are still plain server-rendered pages.
- The shared header status is only truly live on `Summary`, because the Summary
  island owns the header while the other pages render `appStatus` once on the
  server.
- The desired UX is "dynamic everywhere" without page flash, so full-document
  auto-reload is the wrong baseline.

The implementation shape to lock in is:

- keep `AppHeader` mostly server-rendered, but move the live `DAEMON` /
  `SNAPSHOT` stack into a reusable header-status island
- keep one body poller per live page instead of one poller per card/list, so the
  page stays internally consistent and we do not multiply fetch loops
- accept separate header polling and body polling on pages that have both; the
  compact header endpoint is cheap enough, and this keeps the header reusable
  across all authenticated pages
- keep `Workspaces` notice banners and mutation forms outside the live region so
  polling never wipes notices or clobbers in-progress form input
- keep `Sessions` filtering URL-driven, and make live polling preserve the
  existing query semantics rather than introducing local client-only filter state

## Open Issues

- No blocking open issues remain for this task.
- Follow-up only: whether to later collapse separate header/body polling on
  `Summary`, `Sessions`, and `Workspaces` into a shared transport.
- Follow-up only: whether to later add hidden-tab throttling or SSE if `2s`
  polling proves noisier than expected.

## Decisions

- `2s` polling cadence is fixed everywhere in this task.
- Small islands means:
  - one shared live header-status island
  - one live body island per page
  - not one independent polling island per Summary tile or per list/card
- `Summary` keeps a full-page-model live endpoint and one body island that owns:
  - Daemon tile
  - Activity tiles
  - Providers
  - Sessions
  - Workspaces
  - Recent Errors
- `Sessions` gets a dedicated live endpoint and one body island that owns:
  - the page summary bar
  - the filtered session activity list
- `Workspaces` gets a dedicated live endpoint and one body island that owns:
  - Write Root Coverage
  - Registered Workspaces
- `Workspaces` register/unregister remains `POST` / redirect / `GET`.
- `Settings`, `Operational`, `Security`, and `Maintenance` get live header
  status only; their page bodies remain static in this task.
- `Login` remains static.
- Do not add hidden-tab pause/resume logic or per-poll error UI in this pass;
  live islands keep the last good render if a poll fails.

## Contract Changes

- Add `/api/chrome-status` returning the existing `AppChromeStatus` model from
  `loadAppChromeStatus()`.
- Keep `/api/summary` returning the existing `SummaryPageData` model from
  `loadSummaryPageData()`.
- Add `/api/sessions` returning the existing `SessionsPageData` model from
  `loadSessionsPageData()`.
- `/api/sessions` must preserve current page query semantics exactly:
  - `view=active` means active-only
  - absence of `view=active` means include stale
  - `workspace=<workspaceId>` filters to sessions linked to that workspace
- Add `/api/workspaces` returning the existing `WorkspacesPageData` model from
  `loadWorkspacesPageData()`.
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
  - `/api/sessions`
  - `/api/workspaces`
- route tests for `/api/sessions` query behavior:
  - `view=active`
  - `workspace=<workspaceId>`
  - combined filter behavior
- existing loader tests remain the primary data-contract checks:
  - `tests/web-summary-loader_test.ts`
  - `tests/web-activity-loader_test.ts`
- do not introduce a new browser/component test harness in this task
- manual acceptance checks:
  - `Summary` updates header status, heartbeat, memory RSS, providers, sessions,
    and workspaces within `2s` without flashing the page
  - `Sessions` updates counts and rows within `2s` without losing current query
    filters
  - `Workspaces` updates coverage and workspace rows within `2s`, while
    register/unregister notices still arrive via redirect and remain visible
  - `Settings`, `Operational`, `Security`, and `Maintenance` show live header
    status without changing page-body behavior
- implementation validation should include:
  - `deno task test`
  - `deno task check`
  - `deno task lint` if the refactor broadens shared frontend structure

## Non-Goals

- Do not add full-page auto-refresh or meta-refresh.
- Do not convert `Workspaces` mutations to AJAX or optimistic UI.
- Do not add SSE, websockets, filesystem watch push, or diff-based endpoint
  payloads.
- Do not make `Settings`, `Operational`, `Security`, or `Maintenance` page
  bodies live in this task.
- Do not break or replace current URL-driven filtering on `Sessions`.
- Do not try to deduplicate all polling into one global client store in this
  pass.

## Implementation Plan

- [ ] Refactor the shared header so the live `DAEMON` / `SNAPSHOT` stack becomes
      a reusable header-status island without hydrating the entire page chrome.
- [ ] Add a shared client polling utility and a shared no-store JSON response
      helper for all live endpoints.
- [ ] Add `/api/chrome-status` and cover it with route/header-cache tests.
- [ ] Split the Summary page so the header status polls separately and the
      Summary body island owns the Daemon tile, Activity, Providers, Sessions,
      Workspaces, and Recent Errors.
- [ ] Add `/api/sessions` and a `Sessions` body island that preserves current
      query-parameter filtering and updates the summary bar plus activity list.
- [ ] Add `/api/workspaces` and a `Workspaces` body island that updates Write
      Root Coverage plus Registered Workspaces while leaving forms and notices
      outside the live region.
- [ ] Wire the shared live header-status island into all authenticated pages
      that already show `appStatus`: `Sessions`, `Workspaces`, `Operational`,
      `Security`, `Settings`, and `Maintenance`.
- [ ] Add focused route tests for the new live endpoints and keep existing
      loader tests as the source of truth for page-data correctness.
- [ ] Run the targeted implementation validation for logic and contract changes,
      then do manual browser verification of Summary, Sessions, Workspaces, and
      header status behavior across authenticated pages.
