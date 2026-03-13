---
id: 7y4mlp9tplfnv8okm498osi
title: 2026 03 06 Kato Web
desc: ''
updated: 1773175443251
created: 1772810034340
---

## Goal

Create `Kato Web` in `apps/web` as a local web operator console that gives
browser access to the same operator-facing information as `kato status --live`,
while also providing deeper drill-down pages and a small set of guided write
workflows for non-CLI-comfortable users.

## Summary

- Build `Kato Web` as a Deno-native local web app in `apps/web`, with the
  Summary page deliberately mirroring the information architecture of
  `kato status --live`.
- Recommend `Fresh` over `Hono` as the primary framework:
  - `Fresh` is more aligned with `[[dev.general-guidance]]` because it is
    Deno-first, gives us SSR + file-based routing + static asset handling +
    islands without choosing a second UI stack.
  - `Hono` would be a reasonable HTTP/router layer if this were mainly a JSON
    API, but for this task the product is a browser UI, not just endpoints.
- Keep business logic framework-agnostic:
  - shared projection/filter/sort logic stays in `shared/src`
  - app-local filesystem loaders live in `apps/web`
  - mutating command logic should be extracted into reusable Deno services
    rather than trapped inside CLI-only command handlers
  - Fresh routes/islands consume those loaders/services, rather than embedding
    file I/O directly in UI components.
- Phase the work:
  - Phase 1: branded Summary page with live refresh and parity with the current
    CLI live surface plus route-backed browsing pages
  - Phase 2: guided write workflows for Workspaces, Settings, and Maintenance
  - Phase 3: web lifecycle/auth polish plus Performance page with
    memory-over-time graph once the daemon has a persisted history source
    suitable for graphing
- Use the provided brand assets from `shared/assets/`:
  - `2026-03_kato-logo_256.png`
  - `2026-03_kato-wordmark_v2_black-outline.png`
- Keep the local-first posture, but require explicit `Kato Web` setup before the
  web server can start.
- Web startup should be fail-closed: if interactive `kato init` or a dedicated
  `kato web init` flow has not configured the web app, `kato web start` should
  refuse to start it.
- Let the web server run even when the daemon is not running, with degraded
  functionality rather than hard failure.
- Support these non-read-only workflows in the browser:
  - register or update workspaces
  - set or delete workspace username mappings, plus default-user settings
  - clean logs and old twins, with optional twin-metadata deletion
- Keep destructive actions deliberate: browser routes should use POST-only
  handlers, audit logging, dry-run where it exists already, and explicit
  confirmation for cleanup execution.

## Discussion

### Framework choice

Recommended choice: `Fresh`.

Why:

- The current tree has no frontend framework to preserve, and `Fresh` gives us
  the app shell we actually need: routes, HTML rendering, static assets, partial
  client interactivity, and a Deno-native deployment story.
- The Summary page will need server-rendered first paint plus lightweight client
  refresh behavior; Fresh islands fit that shape cleanly.
- The app will likely need a mix of:
  - full page routes (`/`, `/sessions`, `/workspaces`, `/operational`, etc.)
  - JSON route handlers for polling/live refresh
  - small interactive widgets for log filters and charts
- `Hono` remains a decent fallback if we later decide `apps/web` should be API
  first and UI second, but that is not the current ask.

Recommended implementation split:

- `apps/web/routes/*` or equivalent Fresh route tree for pages and JSON
  endpoints
- `apps/web/src/loaders/*` for filesystem-backed read models
- `shared/src/*` for reusable projection helpers and additive view contracts

### Scope and page map

The Summary page should intentionally resemble `kato status --live`, including
the sections that exist today in `apps/cli/src/commands/status.ts`, not just the
session list:

- daemon/header state
- recordings/session counts
- memory summary
- workspace summary/details
- recent operational + security errors
- active/stale sessions and active recordings

Proposed route-backed information architecture:

- `/` Summary dashboard, live-refreshing, visually close to `status --live`
- `/sessions` complete session list from persistent session metadata, not just
  the in-memory status snapshot
- `/sessions` should also carry the browser recording view, because recordings
  belong to sessions; show active and historical recording rows inline rather
  than forcing a separate recordings-first page
- `/workspaces` registered workspace list, config validity details, and
  workspace register/update forms
- `/operational` operational log viewer with level/event/text filters
- `/security` security-audit log viewer with the same filter model
- `/settings` view/edit user defaults, exclude-me behavior, and workspace
  username mappings
- `/maintenance` guided cleanup workflows for logs and old twins,
  with dry-run and confirmation
- `/performance` memory snapshot, counters, and eventually a
  memory-usage-over-time graph

Use route-backed tabs/navigation rather than purely client-side tabs so:

- URLs are stable/shareable
- each page can own its loader/API shape
- the app remains usable with minimal client JavaScript

### Data sources and parity boundaries

The current CLI live view is assembled from multiple sources, and the web app
should follow the same split instead of overloading `status.json`:

- Summary homepage:
  - `~/.kato/shared/status.json`
  - workspace registry/config validation
  - daemon operational log tail
  - daemon security-audit log tail
- Sessions page:
  - persistent session metadata from
    `apps/runtime/src/orchestrator/session_state_store.ts`
  - session metadata `workspaceOutputs` / recording cycle history rendered
    inline with the owning session
- Workspaces page:
  - workspace registry + workspace config validation
  - shared behavior config for `allowedWriteRoots`
  - workspace config `workspaceId` initialization/enforcement
- Settings page:
  - `kato-user-config.yaml` plus alias lookup from workspace registry
- Maintenance page:
  - daemon status snapshot for safety preconditions
  - runtime log files
  - persistent session store / session artifact directories
- Performance page:
  - current snapshot memory fields from `status.json`
  - historical memory samples require a new persisted read model

Important boundary:

- `status.json` is enough for the Summary page and live header sections.
- `status.json` is not enough for "complete list of all sessions in storage" or
  "complete recordings list" because it reflects the daemon's current status
  projection, not the full persistent store.
- Mutating web workflows should call the same underlying stores/validators as
  CLI commands; the web app must not shell out to the CLI binary.

### Live refresh model

For phase 1, prefer browser polling of app-owned JSON endpoints instead of
WebSockets or direct filesystem watching in the browser.

Recommendation:

- server-render initial HTML
- client polls Summary JSON every 2 seconds, matching the current CLI cadence
- detail pages poll less aggressively or only on explicit refresh

Why:

- simpler and cross-platform
- matches the existing file-based control/status model
- keeps live behavior deterministic without introducing another transport

Server-side `Deno.watchFs` or SSE can be added later if polling becomes too
coarse or noisy.

### Web and daemon lifecycle

Recommended lifecycle model:

- The web app should be able to run while the daemon is stopped.
- In that state, the UI should clearly show degraded mode:
  - live daemon summary data is stale or unavailable
  - workspace/settings/maintenance pages still work
  - persisted sessions, recordings, and logs can still be browsed
- Keep daemon and web as separate processes with separate commands.

Recommended CLI surface:

- `kato start|stop|restart` daemon only
- `kato web start|stop|status` web server lifecycle
- `kato web open` optional convenience command that can start the web server if
  needed and open the UI

Recommendation:

- Do not add `startWebWithDaemon` as the primary model.
- Do not change `kato start` to mean "daemon plus web" by default.

Why:

- `kato start` already has a clear daemon-only contract today.
- The two processes have different usefulness and failure modes.
- Debugging and operator expectations stay cleaner when lifecycle is explicit.

If a one-command convenience path is still desired later, prefer an explicit
command such as `kato up` or `kato web open` rather than silently changing the
meaning of `kato start` via config.

### Mutation model and safety

This task is no longer purely read-only. The web app should support selected
operator actions for people who are not comfortable with CLI flows:

- workspace register/update
- user default and workspace username mapping changes
- cleanup of logs and old twins

Mutation guidance:

- Do not spawn `kato` subprocesses from the web app.
- Extract the core logic now living in CLI command handlers into reusable
  services so CLI and web call the same validation and persistence paths.
- Preserve CLI behavior and side effects:
  - workspace registration may update `allowedWriteRoots`
  - workspace registration may surface restart-required warnings
  - session cleanup may run while daemon is active because it only removes
    derived Kato artifacts, not provider source files
  - all actions must emit operational and audit events
- Prefer POST/redirect/GET style handlers for mutations.
- Bind locally and add lightweight request-origin protection so a mutating local
  web service is not trivially drive-by callable from another browser tab/site.
- Cleanup flows should default to dry-run where available and require explicit
  confirmation before actual deletion/flush.

### Local auth posture

Recommended direction:

- Web setup must be explicit. If the user has not completed interactive
  `kato init` or a dedicated `kato web init` flow, the web app remains
  unconfigured and `kato web start` must fail closed.
- Interactive web setup should capture sensitive web settings rather than
  inventing insecure defaults.
- The setup flow should provision initial web credentials.
- Whether auth is mandatory after setup or configurable-on/off remains an
  implementation decision, but unconfigured startup must not be allowed.
- If auth is enabled, treat it as an app-wide gate, not only a mutation gate,
  because the read surfaces are still operationally sensitive.
- Do not store plaintext passwords. Persist a password hash (or equivalent
  verifier) only.
- Keep `kato init` non-interactive by default so scripts and current workflows
  remain stable.
- If we bootstrap credentials through init, prefer an explicit interactive path
  such as `kato init --interactive` rather than surprising users with prompts in
  non-TTY contexts.
- If the auth/bootstrap flow grows beyond one prompt sequence, prefer a
  dedicated command such as `kato web init` or `kato web auth init` over
  overloading plain `kato init`.

This is different from remote multi-user auth/authorization:

- local optional auth is in scope for this task if we choose it
- remote access, multi-user roles, and broader authorization models remain out
  of scope

### Branding and UX direction

The app should use the provided logo and wordmark in the primary shell/header.
The Summary page should feel like a browser-native evolution of the CLI live
view, not a generic admin template:

- strong monospace influence for data panes
- explicit sectioning that mirrors the CLI blocks
- readable dense tables/lists for logs and sessions
- clear operator-console framing

### Scenario parity table

| Scenario                                        | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes                                                                                                                             |
| ----------------------------------------------- | ------------------ | ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon running with active sessions/recordings  | Yes                | Yes                    | Yes            | Summary page should match CLI ordering/filtering                                                                                                         |
| Daemon stopped or stale heartbeat               | Yes                | Yes                    | Yes            | Same stale/running semantics as current status display                                                                                                   |
| Workspace registry contains invalid entries     | Yes                | Yes                    | Yes            | Invalid workspaces should surface both in Workspaces and recent errors summary                                                                           |
| Recent operational/security errors exist        | Yes                | Yes                    | Mostly         | Same visibility goal; browser-side flush/dismiss is optional and not required for the first mutation slice                                               |
| Active-only vs include-stale session visibility | Yes                | Yes                    | Yes            | Shared filtering helpers should define this once                                                                                                         |
| Complete session list beyond in-memory snapshot | Yes                | No                     | No             | Web app should intentionally go deeper than CLI live by reading persistent session metadata                                                              |
| Workspace registration/update                   | Yes                | No                     | No             | Browser adds guided create/update workflow using the same validation and shared-config side effects as CLI                                               |
| User mapping/default updates                    | Yes                | No                     | No             | Browser extends beyond CLI live into settings management for non-CLI users                                                                               |
| Session/log cleanup                             | Yes                | No                     | No             | Browser should require dry-run plus explicit confirmation; session cleanup may run while daemon is active because provider source files remain untouched |
| Web app running while daemon is stopped         | Yes                | No                     | No             | Browser should intentionally degrade rather than refusing to start                                                                                       |
| Web app not yet configured                      | No                 | No                     | No             | `kato web start` should fail closed until interactive web setup has completed                                                                            |
| `kato start` behavior                           | Yes                | No                     | Yes            | Keep the existing daemon-only meaning; web lifecycle should be separate                                                                                  |
| Optional web auth enabled                       | Yes                | No                     | No             | Browser adds an app-wide login gate even though CLI has no analogous surface today                                                                       |
| Memory over time graph                          | No                 | No                     | No             | Requires new persisted history source; current CLI live only shows point-in-time memory                                                                  |

## Open Issues

- None currently recorded.

## Decisions

- Keep the Summary page workspace surface to the summary line plus navigation
  into the dedicated Workspaces page, rather than embedding the full detailed
  Workspaces section on the homepage.
- Use route-backed navigation styled as tabs.
- Put cleanup flows on a dedicated `/maintenance` page.
- Defer `kato web open` from the first lifecycle slice; ship
  `kato web start|stop|status` first.
- Let recent-error panels on the Summary page use a slightly larger
  browser-friendly window than the current CLI `8`-item view.
- On the Sessions page, include direct links to output files when they still
  exist, alongside active and historical recording-cycle data for each session.
- Keep web workspace registration behavior aligned with CLI behavior by
  automatically extending `allowedWriteRoots` when the existing CLI flow would
  do so.
- For the first local-only protection slice, require localhost binding plus web
  auth for mutating routes.
- Store web auth/config in a dedicated web config file under `~/.kato`.
- Support both auth bootstrap paths over time: keep `kato init --interactive` as
  one entry point, and allow a dedicated web auth/bootstrap command as the flow
  grows.
- Require auth for all web access after explicit setup; do not leave read-only
  localhost browsing unauthenticated, because both conversation data and
  operator/daemon state are privacy-sensitive.
- Standardize on separate daemon and web lifecycle commands rather than adding
  daemon/web startup coupling.
- Include workspace unregister in the first web mutation slice.
- Use a new persisted ring buffer file as the source of memory history for the
  Performance page if that page ships in this task.
- Defer broad CLI/web projection unification; keep shared helpers additive where
  they are clearly useful, but do not force a shared view-model layer now that
  the web IA has intentionally diverged from the CLI status surface.
- Update `[[dev.codebase-overview]]`, `[[dev.decision-log]]`,
  `[[dev.general-guidance]]`, and `[[dev.testing]]` as part of the same slice;
  update `[[dev.security-baseline]]` too if auth or request-origin protections
  change the normative security contract.

## Contract Changes

Expected additive changes:

- Move CLI-only view types that web also needs into shared contracts/helpers:
  - workspace status summary row/model
  - recent status error model
  - any formatting-independent summary projection helpers
- Extract mutation logic from CLI handlers into reusable services shared by CLI
  and web:
  - workspace register/update service
  - user settings / mapping mutation service
  - maintenance clean service
- Add a dedicated web config contract/store for web-server settings:
  - bind host / port
  - optional auth configuration
  - future web-specific lifecycle/settings fields
- Add explicit web bootstrap/config state so startup can distinguish:
  - unconfigured web app
  - configured but stopped
  - configured and running
- Add web-facing read models for pages that need more than
  `DaemonStatusSnapshot`:
  - `WebStatusSummary`
  - `WebSessionListEntry`
  - `WebRecordingListEntry`
  - `WebLogPage` / `WebLogFilter`
  - `WebUserSettingsView`
- Add web-facing mutation request/result models as needed:
  - `WorkspaceRegisterRequest` / `WorkspaceRegisterResult`
  - `UserSettingsUpdateRequest`
  - `UserMappingUpsertRequest`
  - `MaintenanceCleanRequest` / `MaintenanceCleanResult`
- If optional web auth is in scope, add a local auth config/session contract:
  - auth enabled flag
  - username
  - password hash / verifier fields
  - session cookie or token settings as needed for local browser auth
- Add web lifecycle/status contracts if `kato web ...` commands are introduced
  in this task.
- Keep `DaemonStatusSnapshot` as the source for Summary/live parity, rather than
  creating a parallel status model.
- If the Performance page is in scope for this task, add a persisted memory
  history contract/file; otherwise explicitly defer the graph.

Contract changes should remain additive, but this task now includes selected
local mutations. Daemon lifecycle/start-stop-export control-plane actions should
still remain out of scope.

## Testing

Required coverage should include:

- shared projection tests confirming web and CLI use the same stale/session
  filtering and ordering rules
- `apps/web` loader tests for:
  - status snapshot loading
  - workspace registry/config validation projection
  - session metadata listing
  - recording history projection
  - user config mapping projection
  - operational/security log filtering
- mutation service and route tests for:
  - workspace register/update validation and persistence
  - user default and mapping changes
  - cleanup dry-run versus execute behavior
  - cleanup behavior while daemon is running
  - audit/operational logging for web-initiated mutations
- degraded-mode tests for running web without daemon: offline Summary rendering,
  unavailable live sections, and continued access to non-daemon-backed pages
- fail-closed startup tests for unconfigured web status: `kato web start`
  refusal before interactive init / web init has completed
- if `kato web ...` lifecycle commands are added: parser/usage/command coverage
  for start/stop/status and any `open` command
- route/handler tests for page data endpoints, query filtering, and POST/PRG
  flows
- render tests for the Summary page so the browser surface does not drift from
  the intended `status --live` structure
- fail-closed tests around missing/invalid files and permission-denied reads
- if local-origin or CSRF protections are added: request rejection tests for
  missing/invalid mutation tokens or origins
- if optional local auth is added: login/logout flow tests, auth-required route
  coverage, bad-credential rejection, and password-hash persistence/bootstrap
  coverage
- if memory history is added: tests for persistence limits, ordering, and
  graph/API projection

Validation workflow before merge:

- `deno task fmt`
- `deno task lint`
- `deno task check`
- `deno task test`

## Non-Goals

- Do not add daemon lifecycle controls (`start`, `stop`, `restart`) or export
  actions to the web UI in this task.
- Do not build a full SPA when server-rendered pages plus small islands are
  sufficient.
- Do not shell out from the web app to CLI subprocesses for mutations.
- Do not silently change `kato start` to mean "start daemon and web" in this
  task.
- Do not introduce network dependencies or cloud coupling for baseline local
  operation.
- Do not broaden maintenance beyond the requested scopes without a separate
  design: logs and old twins are in scope; `clean --recordings` is
  still unimplemented and should stay that way unless separately designed.
- Do not treat remote multi-user auth/authorization as part of this slice;
  optional local auth is acceptable, but broader remote access and role models
  are not.
- Do not let Summary-page parity block deeper pages or guided mutations where
  the browser can reasonably provide a better operator experience than CLI live.

## Implementation Plan

- [x] Decide and record the framework choice in `[[dev.decision-log]]`: use
      `Fresh` as the primary `apps/web` framework unless a concrete blocker
      appears during scaffolding.
- [x] Record the boundary change in `[[dev.decision-log]]` and
      `[[dev.codebase-overview]]`: `apps/web` is no longer only a read-only
      status surface; it now owns a small set of local operator workflows.
- [x] Scaffold `apps/web` as a Fresh app while preserving existing
      framework-agnostic exports under `apps/web/src`.
- [x] Add and document a separate web lifecycle model: web can run without
      daemon, `kato start` stays daemon-only, and `kato web ...` owns web-server
      lifecycle commands.
- [x] Re-evaluate whether reusable non-CLI-specific status view models should
      move into `shared/src`.
      Decision: defer this refactor. The web surface now has enough distinct
      route-specific IA and loader behavior that forcing CLI/web projection
      unification in this slice would add churn without enough benefit.
- [x] Extract reusable mutation services from the current CLI command handlers
      so CLI and web share the same business rules for: workspace
      register/update, user settings/mappings, and maintenance clean.
- [x] Introduce a dedicated web config/store for bind settings and optional
      auth, instead of overloading participant/user settings config.
- [x] Make web startup fail closed until explicit web setup has completed:
      non-interactive `kato init` must not silently configure the web app, and
      `kato web start` must refuse startup while web config/bootstrap is absent.
- [x] Add `apps/web` loader modules for: initial status snapshot loader for the
      Summary page.
- [x] Expand `apps/web` loader modules for: status snapshot, workspace
      registry/config validation, user config, persistent session metadata,
      recording history, and log reads.
- [x] Implement the Summary route first so it mirrors `kato status --live` as
      closely as practical in a browser: header, recordings/sessions, memory,
      workspaces summary/details, recent errors, and live session rows.
- [x] Add a lightweight live-refresh mechanism: route handler JSON payload plus
      browser polling on the Summary page.
- [x] Wire the supplied logo/wordmark assets into the app shell and Summary
      header.
- [x] Add the Workspaces route with register/update flows, including the same
      validation and `allowedWriteRoots` side effects used by CLI today.
- [x] Add the Settings route with forms/actions for: default username,
      exclude-me behavior, and workspace username map set/delete.
- [x] Add a Maintenance route with guided clean flows for logs and sessions:
      dry-run first, explicit confirmation for execution, and shared cleanup
      behavior with CLI.
- [x] Add route-backed detail pages for Sessions, Workspaces, Operational
      Details, Security, and Settings using shared loaders, with recordings
      still integrated into Sessions and also available on a dedicated
      recordings page.
- [x] Add local-only mutation protections appropriate for a localhost operator
      console: POST-only handlers, origin/CSRF protection, and clear
      confirmation UX for destructive actions.
- [x] Decide and document the local auth posture for `Kato Web`: explicit web
      setup is required before startup; then decide whether configured localhost
      access is always auth-gated or may explicitly opt into unauthenticated
      mode.
- [x] If optional auth is in scope, decide where the credential/config contract
      lives and keep stored credentials hash-only.
- [x] Keep `kato init` stable for automation, and if auth bootstrap is part of
      this slice, add an explicit interactive setup path rather than making
      plain `kato init` unexpectedly prompt.
- [x] If lifecycle/auth bootstrap UX is in scope, decide whether the clearer
      long-term command is `kato init --interactive`, `kato web init`, or
      `kato web auth init`.
- [x] Decide whether Performance is in the first implementation slice: if yes,
      add a persisted memory-history source and graph page; if not, ship the
      page as a current-snapshot-only placeholder or defer it.
      Decision: defer the Performance page from this slice.
- [x] Add focused tests for loaders, shared projections, mutation services, page
      handlers, Summary render parity, and any adopted local auth flow.
- [x] Extend CLI status surfaces to include `Kato Web` runstate and show recent
      web-app operational/auth errors alongside daemon/operator errors where
      appropriate.
