---
id: acwq5187n521eusrb7dkkph
title: 2026 03 15 Legible Timestamps
desc: ''
updated: 1773604916637
created: 1773602878816
---

## Goal

Replace ISO-style UTC timestamps in the web UI with a friendlier local-time
display such as `2026-03-15 12:32:56` across all current web timestamp
surfaces, including Sessions, Recordings, Maintenance, Logs, Summary, and
Workspaces.

## Summary

- `apps/web/src/time.ts` currently normalizes valid timestamps with
  `Date.toISOString()`, so the UI shows machine-style UTC values with `T`/`Z`
  rather than the operator's local clock time.
- The shared formatter is used across Sessions, Recordings, Maintenance Twins,
  Logs, Workspaces, and Summary, so even a small formatting tweak has
  cross-page impact.
- This should stay a presentation-only change. Stored timestamps and API
  payloads should remain canonical ISO strings.
- Visible timestamps should omit timezone abbreviations for now.

## Discussion

- Desired display is local browser time in a fixed, readable shape like
  `YYYY-MM-DD HH:mm:ss`.
- The chosen SSR/hydration approach is to render a stable fallback first, then
  replace it on hydration with browser-local time. The server does not know the
  browser timezone, so this avoids incorrect server-side local rendering.
- `formatTimestamp()` is currently used by:
  - Sessions inventory rows
  - Recordings rows
  - Maintenance twins rows
  - Log entry rows
  - Workspace recording summaries
  - Summary heartbeat / recent error timestamps
- This task now explicitly covers all current shared web timestamp surfaces in
  the existing formatter call sites, rather than only the originally named
  pages.
- Keeping a machine-readable ISO timestamp in a tooltip or `<time datetime>`
  attribute would preserve debugging value while improving the visible copy.

## Open Issues

- None currently. Follow-up feedback can determine whether the ISO tooltip
  remains useful or should be softened later.

## Decisions

- Track this as a task note because it crosses multiple user-facing pages and
  needs an explicit decision on local-time rendering behavior, not just a one
  line formatter swap.
- Keep backend/storage timestamp contracts unchanged unless a concrete need
  emerges during implementation.
- Scope includes Summary, Workspaces, and all other current web uses of the
  shared timestamp formatter in this pass.
- Visible absolute timestamps should omit timezone abbreviations for now.
- Preferred rendering strategy is a stable server-rendered fallback that is
  replaced with browser-local time after hydration.
- The stable pre-hydration fallback should remain the canonical ISO timestamp.
- Valid rendered timestamps should preserve canonical ISO in both
  `<time datetime>` and `title`.

## Contract Changes

- None expected. API responses should continue to emit canonical ISO timestamps.

## Testing

- Update `tests/web-time_test.ts` for the new formatter behavior using a
  deterministic formatting path that can be exercised in tests.
- Add or adjust UI tests if needed for the affected pages/components that render
  timestamps.
- Manually verify local rendering on Sessions, Recordings, Maintenance, Logs,
  Summary, and Workspaces, including invalid timestamps and DST-sensitive
  dates.
- Focused verification completed:
  - `deno test tests/web-time_test.ts`
  - `deno check main.ts client.ts routes/**/*.tsx src/**/*.ts islands/**/*.tsx islands/**/*.ts` from `apps/web`

## Non-Goals

- Changing stored timestamp formats on disk or over the wire.
- Adding user-configurable locale/timezone preferences in this pass.
- Reworking existing relative-time labels beyond keeping them compatible with
  the new absolute timestamp display.

## Implementation Plan

- [x] Define the exact pre-hydration fallback text and whether canonical ISO is
      preserved in tooltip or `datetime` metadata.
- [x] Refactor the shared web timestamp helper so it can render browser-local
      timestamps without changing API/storage formats.
- [x] Apply the formatter across all current web timestamp surfaces, including
      Sessions, Recordings, Maintenance, Logs, Summary, and Workspaces.
- [x] Update automated tests and manually verify the affected pages.
