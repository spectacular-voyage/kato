---
id: 5rbmfysnpl285dpkzrflnnx
title: Leave Fresh
desc: Replace Fresh 2 in Kato Web with Hono routing, server-rendered Preact pages, a small in-repo island mounter, and a plain Vite client build, without changing what users see.
updated: 1794334438105
created: 1794334438105
---

## Goal

Kato Web runs without Fresh, on Deno 2.9, with the same pages, forms, live polling, auth, and URLs. No `@fresh/*` package remains in any lockfile. The server code no longer needs a build step, and the client build is plain Vite. This is stage 1 of [[task.2026.2026-11-10-platform-migration]].

## Summary

How Kato Web uses Fresh today (2026-11-10):

- **App wiring** (`apps/web/web_app.ts`): one Fresh `App` with four middlewares, in order:
  1. Error logging.
  2. `staticFiles()`: serves files that exist in the build output, before auth. A missing file falls through to the next middleware.
  3. State init: `appName`, `authenticated`, `csrfToken`, `pathname`.
  4. Auth:
     - `/login` and `/_fresh/*` skip session enforcement.
     - Non-GET/HEAD requests to them must be same-origin.
     - Login is exempt from CSRF even when a session exists.
     - Everything else returns 503 when unconfigured.
     - An unauthenticated `/api/*` request gets a 401 JSON response, and an unauthenticated page request gets a 302 to `/login`. Both happen before any origin check.
     - Authenticated non-GET/HEAD requests must be same-origin and carry a valid CSRF token.
     - `createWebApp` also starts the web status heartbeat.

  Then `app.fsRoutes()`.
- **Routes** (`apps/web/routes/`): 21 files, made up of `_app.tsx` plus 20 endpoints.
  - 10 pages, 7 of them with a `POST` handler.
  - 8 `/api/*` JSON endpoints.
  - `logout`, which answers GET with 405 and handles POST.
  - A legacy `/brand/:asset` redirect, which runs after auth.
  - Three dynamic route patterns.
- **Route API surface is narrow:** routes use only `ctx.req`, `ctx.url`, `ctx.params` and `ctx.state.csrfToken`.
  - **Pages** are `async` components that load their own data. Most set their title with Fresh's `<Head>`; login has no `<Head>` and inherits the layout's "Kato Web" title.
  - **POST handlers** differ:
    - Recordings and workspace-config edit delegate to framework-free functions that take the `Request`; logout's logic sits in a small helper in its route file.
    - Login, Sessions, Settings, Workspaces and Maintenance parse forms, dispatch, log and build redirects inline (for example `routes/sessions.tsx:95`).
- **Islands:** seven components cross the server/client boundary:
  - `SummaryLive`, `SessionsLive`, `RecordingsLive`, `WorkspacesLive` and `MaintenanceTwinsLive`, one per page;
  - `HeaderStatusLive`, inside `AppHeader`;
  - `LogsResultsLive`, inside `LogPageView`.

  Their props are JSON-compatible data, endpoint strings, an optional CSRF token, and numbers or booleans. No island receives JSX children or functions. Optional fields can be `undefined` and disappear in JSON, which the islands already tolerate because their polling endpoints return the same types through `Response.json`.
  The other modules in `islands/` (`SessionSnippet`, hooks, `auth_expiry.ts`) are used only inside islands.
- **Island mounting:** Fresh 2.3.3's reviver mounts each island with `render()`, not `hydrate()`, scheduled through `scheduler.postTask` or `setTimeout(…, 0)`. It also emits module-preload links for the runtime and the islands a page uses.
- **Build:** `vite build` with `@fresh/plugin-vite` produces `_fresh/server.js` and `_fresh/client/`. The client output holds the CSS, the island chunks under `/assets/*`, and `static/brand/*`.
  - **Source mode:** `kato web start` rebuilds when anything under `apps/web` (except `_fresh` and `node_modules`), `apps/runtime/src` or `shared/src` is newer than `_fresh/server.js`. It then runs `deno serve -A _fresh/server.js`.
  - **Binary:** `kato-web` is compiled from `src/compiled_main.ts` with `--include _fresh`, and calls `Deno.serve(options, fetch)` with the parsed host and port.
- **Routes need the build:** an unbuilt `createWebApp().handler()` has no routes. An in-process probe returned 404 for `POST /login` and 500 for authenticated pages. The built `_fresh/server.js` serves everything.
  - **Default paths:** login, logout and the page loaders resolve the default `~/.kato` locations, not the `katoDir` passed to `createWebApp`, so tests must isolate `HOME`.
  - **Error responses:** Fresh's production 404 and 500 are plain text.
- **The client graph leaks server code:**
  - `src/log_results.tsx` and `src/log_page.tsx` import `DEFAULT_LOG_LEVEL_FILTER` from the server loader `src/loaders/logs.ts`, which imports `@kato/runtime` and `jsr:@std/path`.
  - `src/session_routes.ts` imports `hashStringFNV1a` from `@kato/runtime`.

  Fresh's Vite plugin resolves Deno specifiers and tree-shakes the leak away; plain Vite cannot resolve them.
- **Tests:** only `apps/web/tests/auth_redirect_test.ts` exercises the assembled app, and it never gets past middleware. `login_page_test.tsx` renders one route component. `tests/web-launcher_test.ts` asserts the generated launch commands. Nothing else checks route wiring, method handling, static serving or successful mutations.
- **Tooling references:** root `fmt`, `lint`, `check` and `exclude` name Fresh-era paths (`apps/web/main.ts`, `utils.ts`, `routes`, `_fresh`), and the web `check` task checks `main.ts` and `routes/**/*.tsx`.

## Design

### Server

- **Hono 5:** pinned exactly to `npm:hono@5.0.0-rc.1` during development, then to `5.0.0` once it ships (see Decisions).
  - Kato uses only the core: routing, middleware, `c.req`, and `app.request()` in tests.
  - It uses no runtime adapters, which v5 moves into separate packages such as `@hono/deno`, and no `serveStatic`.
  - The v5 changes this design touches:
    - `onError((c) => …)` takes only the context and reads the error from `c.error`. A thrown non-`Error` arrives wrapped in an `Error`, with the original value in `c.error.cause`.
    - `c.req.query()` values are typed `string | undefined`. Route modules read the query from `RouteContext.url` instead.
    - `c.json(undefined)` throws, as `Response.json()` does. API handlers always return an object.
- **Entry:** `apps/web/server.ts` exports `createWebApp(options)`. It starts the status heartbeat, as today, and returns the Hono app.
- **Server main:** `apps/web/src/server_main.ts` replaces `compiled_main.ts`. It keeps the same startup error handling and exit code 2, parses `--host` and `--port`, and calls `Deno.serve(options, app.fetch)`. Source mode and the compiled binary share this entry.
- **Middleware:** the same four, in the same order and with the same rules as listed under Summary.
  - The static middleware answers only for keys in the asset allowlist (see Assets) and passes everything else on.
  - The `/_fresh/*` exemption goes away.
  - The legacy `/brand/:asset` redirect stays a route behind auth.
  - Errors are logged in `app.onError((c) => …)` from `c.error`, and the handler returns a plain-text 500 like Fresh's.
- **Routing:** an explicit table in `apps/web/app_routes.ts` replaces file-based routing.
  - Behaviour where Fresh and Hono differ is matched to what the characterization suite records for Fresh:
    - trailing and repeated slashes;
    - `HEAD` and `OPTIONS`;
    - methods a route does not define;
    - percent-encoded params.
  - This uses Hono's `strict: false` plus explicit handling where that is not enough. What the characterization suite recorded for Fresh, and how a probe of Hono `5.0.0-rc.1` with `strict: false` compares:

    | Behaviour | Fresh (recorded) | Hono 5 RC |
    |---|---|---|
    | `/sessions/` | the page | the page |
    | `//sessions`, `/sessions//` | the page (repeated slashes collapsed) | 404; collapse slashes before routing |
    | Path case (`/SESSIONS`) | 404 | 404 |
    | Method a page with handlers doesn't define (`PUT /sessions`), after auth and CSRF | 404 `Not Found` | 404 |
    | Any method on a component-only page (`/`, `/logs`, `/sessions/:id`) | renders the page | must register all methods for these |
    | `POST` or `OPTIONS` on a GET-only API | 404 `Not Found` | 404 |
    | `OPTIONS` or `PUT` without a CSRF token | 403 `csrf token required` (auth runs first) | same, since auth is middleware |
    | `OPTIONS` or `PUT` on `/login` | 404 (`/login` skips CSRF) | 404 |
    | `HEAD` | the `GET` handler with an empty body; `HEAD /logout` is 405 | same |
    | `%20` in a param | decoded (`a b`) | decoded |
    | `%2F` in a param | kept encoded (`a%2Fb`); Fresh uses `decodeURI` | decoded to `/`; read the raw segment and apply `decodeURI` |

  - **Redirect `Location`s:** `Response.redirect` and the auth middleware give absolute URLs (`http://host/login`), while login success (`/`) and logout (`/login`) set relative ones by hand. Query values use two encodings: `URLSearchParams` (`+` for spaces) on Sessions, Maintenance, Recordings and workspace config, and `encodeURIComponent` (`%20`) on Workspaces and Settings. The page modules keep their own redirect code, so both carry over as they are.
  - **Recordings `POST`** reads the CSRF token from the form body itself, so a token sent only in `x-kato-csrf` passes the middleware and is then refused with 403.

### Routes

- **Context:** a Kato-owned context in `apps/web/src/route_context.ts`.

  ```ts
  interface RouteContext {
    req: Request;
    url: URL;
    params: Record<string, string>;
    state: { appName: string; authenticated: boolean; csrfToken?: string; pathname: string };
  }
  ```

  An adapter builds it from Hono's `c`, and another from Fresh's `ctx` while both exist. Route modules depend on this type, not on Hono or Fresh.
- **Route modules** move from `routes/` to `apps/web/pages/` and export plain functions (done in step 3):
  - `GET`/`POST` handlers: `(ctx: RouteContext) => Response | Promise<Response>`.
  - `page`: `(ctx: RouteContext) => Promise<PageResult>`, where `PageResult` is `{ title?: string; body: VNode }` (`pages/page.ts`).
    - `PageResult` lives in `pages/` rather than `src/route_context.ts`. That keeps `src/` free of Preact imports, because the root config type-checks `src/**/*.ts`.
  - The API and legacy brand routes already delegate to `src/live_routes.ts` and `src/brand_assets.ts`, so the route table will call those directly instead of going through `pages/`.
  - **No `islands` list on `PageResult`:** the renderer will record which islands a render actually used (render-scoped, like the props ids) and emit preloads from that. A hand-kept list would go stale, since `HeaderStatusLive` comes in through `AppHeader` on every page.

  A page loads its data, then returns a tree that renders synchronously. This replaces both async components, which synchronous `preact-render-to-string` cannot await, and `<Head>`. Without a title, the layout's "Kato Web" is used, as login does today.
- **Inline POST logic** moves into those functions unchanged: form parsing, dispatch, logging and redirect construction. Only the context type changes.
- **Rendering:** `renderPage(ctx, result)` returns `"<!DOCTYPE html>" + renderToString(<Layout …>{body}</Layout>)` as `text/html; charset=utf-8`.
  - The layout keeps today's `_app.tsx` markup.
  - It adds the client stylesheet, the client entry, and module-preload links for the runtime and the page's islands. These are resolved from the Vite manifest by following each entry's `imports` and `css`, as Vite's backend-integration guide describes, with root-relative URLs so nested routes resolve them.
  - `preact-render-to-string` is declared directly in the web import map.

### Islands

- **Server side:** `island(name, Component)` in `apps/web/src/island.tsx` wraps a boundary component. It renders:
  - a `<kato-island data-island="Name" data-props="n">` element holding the server markup;
  - followed by a `<script type="application/json" id="kato-island-props-n">` element.

  The ids come from a counter scoped to one render, not a module-level counter, so concurrent requests can't interleave. `kato-island { display: contents }` keeps layout identical; the CSS has no child combinators that target island roots.
- **Props:** `JSON.stringify(props)`, with every `<` replaced by its JSON Unicode escape (a backslash followed by `u003c`). The result is written with `dangerouslySetInnerHTML`. Rendering it as ordinary children would HTML-escape quotes and ampersands, which then break `JSON.parse`, because script content is not entity-decoded.
- **Boundaries:** routes, `AppHeader` and `LogPageView` import the wrapped versions from one module, `apps/web/src/island_boundaries.tsx`. Island files themselves don't change.
- **Client side:** `client.ts` imports the stylesheet and a registry of `name → () => import("./islands/Name.tsx")`. For each `kato-island`, it reads the props script and mounts with `render(h(Component, props), element)`, deferred through `scheduler.postTask` or `setTimeout(…, 0)`, exactly as Fresh does today.
  - **Duplicate mounts:** a mounted element is marked so a second pass cannot mount it twice.
  - **Chunk failures:** a chunk that fails to load leaves the server markup in place and logs to the console.
  - **`hydrate()`:** switching to it is not part of this stage. Evaluate it with Preact 11, where hydration changed.

### Client build

- **Vite only, with no framework plugin:**
  - `esbuild` JSX set to `automatic` with `jsxImportSource: "preact"`;
  - `resolve.alias` maps `@kato/shared` to `shared/src/mod.ts`;
  - `publicDir: "static"`;
  - `build.manifest: true`;
  - `outDir: "dist"`;
  - input `client.ts`.

  `dist/` holds `assets/*` (hashed) and `brand/*`. `preact` and `preact/hooks` resolve from `apps/web/node_modules` (`nodeModulesDir: "auto"`). An in-memory, plugin-free Vite build of the seven island entries, with the fixes below substituted, succeeded in review.
- **The client graph must stay server-free:**
  - Move `DEFAULT_LOG_LEVEL_FILTER` to a client-safe module.
  - Move the body of `apps/runtime/src/utils/hash.ts` (no imports) to `shared/src`. Keep `apps/runtime/src/utils/hash.ts` as a forwarding module, because `session_state_store.ts` and `apps/daemon/src/utils/hash.ts` import it directly.
- **Guard test:** walks value imports, re-exports and dynamic imports from `client.ts` and `islands/`. It fails on:
  - `@kato/runtime`;
  - relative imports into `apps/runtime`;
  - `jsr:` and `node:` specifiers;
  - `npm:` specifiers other than `preact`;
  - any use of `Deno.`.
- **Server-side JSX:** stays `"jsx": "precompile"` until cutover. Preact's runtime and `preact-render-to-string` both handle Deno's precompile output, so the new server can run alongside Fresh. At cutover, `apps/web/deno.json` moves to `"jsx": "react-jsx"` with `"jsxImportSource": "preact"` and drops `jsxPrecompileSkipElements`.
- **Keep JSX out of the root check:** server wiring that imports `.tsx` lives in `apps/web` outside `src/`, or the root `check` task stops covering it. The root config has no Preact JSX settings, and the web `check` task covers it instead.

### Assets

- **Allowlist:** at startup, an `AssetSource` builds a fixed allowlist of URL keys, from the files the manifest references plus the files copied from `static/`. Requests outside the allowlist fall through to auth. No path from the request is ever joined to a filesystem path, which matters because the binary has broad read permission and these files are served before auth.
- **Lookup:** `AssetSource.get(key)` returns `{ body, contentType, etag, cacheControl }`. The stage 1 implementation reads `dist/` through a module-relative `file:` URL, which works from source and inside `deno compile --include dist`.
- **Headers:** match what the characterization suite records for Fresh:
  - ETag with `304` on `If-None-Match`;
  - `Vary`;
  - `content-length`;
  - `HEAD`;
  - rejection of other methods;
  - per-class `cache-control` for hashed assets versus `brand/*`.
- **Later runtimes:** an embedded implementation (a generated path-to-bytes module) is a stage 3 concern for Bun or Node binaries. The interface is what keeps it swappable.

### Launcher and binary

- **Source mode** (`apps/runtime/src/web/mod.ts`):
  - **Staleness:** keeps today's broad scan of `apps/web` (excluding `dist` and `node_modules`), `apps/runtime/src` and `shared/src`. That covers `static/`, `deno.json` and `deno.lock`.
    - The scan compares against `dist/.vite/manifest.json`.
    - The build also counts as stale when any file the manifest references is missing.
  - **Serve:** both the shell and PowerShell paths run `deno run --node-modules-dir=auto -A src/server_main.ts --host … --port …`.
  - **Build-latency reporting:** stays.
- **`scripts/build-binaries.ts`:** `kato-web` compiles `src/server_main.ts` with `--include dist`. Permissions are unchanged (`--allow-read --allow-write --allow-env --allow-net`).
- **Tasks and config:**
  - `apps/web/deno.json`:
    - `build` = `vite build`;
    - `dev` runs one initial build, then `vite build --watch` and `deno run --watch` on the server entry, and stops both on exit;
    - `start` and `update` are removed.
  - Lint drops the `fresh` rule tag.
  - The root `fmt`, `lint`, `check` and `exclude` lists and the web `check` task replace the Fresh-era paths.
  - `.gitignore` gains `apps/web/dist`.
- **CI:**
  - `ci:quality` gains `deno task --cwd apps/web build`.
  - The Windows and macOS test jobs build the client before tests that need `dist/`.

## Decisions

- Keep Kato Web server-rendered with post/redirect/get forms; do not convert it into a single-page app.
- **Hono rather than a hand-written router.** About 20 routes, three params and four middlewares would fit in under 100 lines over `URLPattern`. But Hono is zero-dependency, runtime-neutral, and provides `app.request()` for tests. Route modules don't import it, so replacing it later stays cheap.
- **Hono 5 from the start, not Hono 4.** Starting on 4 would mean migrating the same code again within months.
  - The Hono-facing code is `server.ts` and `app_routes.ts`. The v5 changes it meets are listed under Server.
  - The risk is building on a release candidate:
    - `5.0.0-rc.1` was published 2026-10-10.
    - As of 2026-11-10, Hono's `v5` branch was last updated 2026-10-22 and is 41 commits behind `main`. v4 is still being patched (4.13.17 on 2026-11-07), and those fixes are not in the RC.
    - The v5 tracking issue ([honojs/hono#5106](https://github.com/honojs/hono/issues/5106)) has its code items done; what's left is tooling, the website and an adapter.
  - **Release gate:** Kato does not ship on the RC by default.
    - If `5.0.0` is out, pin it and rerun characterization.
    - If it isn't, review the fixes on Hono `main` that the pinned RC lacks, in the code Kato uses (router, context, request, compose). Then decide either to ship on the RC or to wait.
- **Island markers are wrapper elements** with `display: contents`, not Fresh-style comment markers, and they mount with `render()` like Fresh. Same mounting semantics, simpler marker handling.
- **The new stack is built alongside Fresh and switched in one cutover.** Fresh keeps owning production until the new app passes the same characterization suite. The cutover commit then switches the Vite config, JSX, client entry, launcher, binary spec, tasks and CI together. Each intermediate commit leaves the shipped app on Fresh and green.
- **Characterization runs against built output.** For Fresh that's `_fresh/server.js`; for the new app it's its own build. `HOME` is isolated in `test:web`, which runs files serially, because the route code resolves default paths. The harness also pre-sets the status heartbeat's global guard, so importing a server starts no timer.
- **No browser-automation suite in this stage.** Hydrator mechanics get DOM-level tests. Behaviour that needs a real browser goes on an explicit manual smoke checklist (under Testing). A headless-browser dependency for seven islands in a local console costs more than it saves; revisit if a mount regression slips through.
- **Embed `dist/` with `--include` on Deno now,** and defer a generated asset module to stage 3 behind `AssetSource`. The platform migration note originally put the generated module in stage 1.
- **Stay on Preact 10 for the swap;** upgrade to Preact 11 afterwards as its own change.
- **Out of this stage:**
  - replacing `@std/http/cookie` and the other `@std/*` imports (stage 2);
  - Node portability of the server (stage 2).

## Contract Changes

No persisted-data, config, CLI, or API-response changes. Observable differences:

| Area | Fresh today | After |
|---|---|---|
| Built asset URLs | `/assets/*` with Fresh's chunk names (`client-entry-*`, `fresh-island__*`) | `/assets/*` with Vite's default names (hashes change every build either way); `/brand/*` unchanged |
| Island mount markup | Comment markers | `<kato-island>` wrappers with `display: contents`, plus a JSON props script per island |
| Source-mode start | Builds server and client bundles; `deno serve _fresh/server.js` | Builds the client when stale; `deno run src/server_main.ts` |
| Developer `dev` task | Vite dev server with HMR | Client rebuild on change plus server restart; reload the browser |
| Encoded separator in a static path (`/brand%2flogo.png`) | Fresh decodes `%2f` and serves the file | Only exact allowlisted paths are served, so the request falls through to auth (302 to login when signed out) |

Everything else is meant to stay identical: status codes, redirects, headers, cache policy, and method and slash handling. Any difference the characterization suite finds is either fixed or added to this table with a reason.

## Testing

**Characterization suite** (written first, against built Fresh):

- **Harness:** `(Request) => Promise<Response>`, with an isolated `HOME` holding an initialized web config, and a session cookie from a real `POST /login`.
- **Placement:** `apps/web/tests/characterization_test.ts`, in `deno task test:web`, which builds the app first and runs its test files one at a time (the `HOME` switch relies on that). The web config supplies the import map the built bundle needs.
- **Assertions:** framework-neutral ones (status, headers, `Location`, `<title>`, key text) are separate from implementation-specific ones (island markers), which run only against the new app.
- **Matrix:** one row per route, method and auth state.
  - **Auth states:**
    - unconfigured;
    - unauthenticated;
    - authenticated;
    - authenticated without CSRF;
    - cross-origin.

    This includes unauthenticated mutations (expected 401 or 302 before the origin check), `HEAD` skipping the mutation guards, and login skipping CSRF.
  - **Pages and APIs:**
    - every page with its expected title;
    - the two dynamic routes with unknown ids, which show the in-page "not found" state;
    - every API route with its expected status (`/api/session-snippet` without `sessionId` returns 400) and `cache-control`.
  - **Mutations:** a valid and an invalid submission for each of the seven POST pages, covering redirect status, `Location` with query and hash, and `Set-Cookie`, plus `GET /logout` → 405 and `POST /logout` → 302 with a cleared cookie.
    - **Fixtures:** the harness seeds a shared config, an unregistered workspace directory and one persisted session. Most success paths need them.
    - **Order:** the rows run in sequence (`mutation_cases.ts`): register the workspace, map a username to it, edit its config, engage a recording on the session, then update and stop the recording. JSON read-backs confirm each effect.
  - **Routing:**
    - trailing and repeated slashes;
    - `HEAD`, `OPTIONS` and an undefined method on a page;
    - an API route and a POST-only route;
    - a percent-encoded dynamic param;
    - an unknown path.
  - **Static:**
    - an existing asset and brand file with no session (200, ETag, `cache-control`);
    - the same with `If-None-Match` (304);
    - `HEAD` and `POST` against an asset;
    - a missing asset, which falls through to auth;
    - traversal and encoded separators;
    - legacy `/brand/logo` with no session (redirects to login) and with a session (307).

**Unit and DOM tests:**

- Props serialization: render with `preact-render-to-string`, parse the HTML with a DOM parser, `JSON.parse` the script, and compare. The fixtures include quotes, ampersands, `</script>`, `<!--`, non-ASCII text, and populated `initialData` from real loaders.
- Mounter (DOM-level):
  - finds markers and reads props;
  - mounts each island once, including on a repeated pass;
  - attaches event handlers;
  - leaves server markup in place when a chunk fails to load;
  - render-scoped ids are unique across instances.
- Client-graph guard test.
- Launcher: updated command assertions in `tests/web-launcher_test.ts`, plus staleness cases for a changed static file, a changed `deno.lock`, and a missing referenced chunk.
- Startup: `server_main.ts` serves `/login` on a non-default port, on all three CI platforms.
- `login_page_test.tsx` moves to the new page module.

**Manual smoke checklist** (before release, from source and from the compiled binary run outside the checkout, on galactica):

- Each page renders populated and polls.
- Interaction before mount (click or type during load) does not break the island.
- Session deep links expand the right tree node.
- The remembered workspace selection is restored.
- Log timestamps update.
- A recording start/stop round trip.
- A settings change.
- A workspace config edit.
- Login and logout.
- A session expired in another tab redirects every open tab.
- `kato web start`, `status` and `stop`, including a detached start that survives the terminal closing.
- On Windows: a path containing spaces and the startup logs.

## Review

An independent review on 2026-11-10 (Codex CLI) found 15 issues in the first draft. All are folded in above:

- unsafe props escaping;
- a harness that could not reach Fresh's routes, with a `katoDir` that did not isolate state;
- a non-shippable cutover order;
- missing task, CI and test updates;
- the hash-module importers;
- imprecise auth and public-path rules;
- routing differences beyond `HEAD`;
- understated POST extraction;
- a too-narrow staleness scan;
- the server entry dropping host and port;
- `hydrate()` instead of Fresh's `render()`;
- static-serving contracts and the pre-auth filesystem boundary;
- several inventory errors;
- module preloads and Hono 5's `onError` change.

Two suggestions were not taken as given:

- **Browser tests** became a manual checklist plus DOM-level tests (see Decisions).
- **Staying on Hono 4 through the migration:** the design starts on Hono 5 instead, with a release gate (see Decisions).

## Open Issues

- **Security headers:** Kato Web sets none (no CSP or frame options). It's out of scope here; noted because the new layout makes adding them easy.

## Implementation Plan

- [x] Characterization harness and suite against the built Fresh server, green on Fresh, in `test:web` after a client build (138 steps).
- [x] Client-graph hygiene: move `DEFAULT_LOG_LEVEL_FILTER`; move `hash.ts` to `shared/src`, keeping the runtime forwarding module; add the guard test.
- [x] Extract page and handler logic (including the inline POST logic) from `routes/` into `apps/web/pages/` against `RouteContext` and `PageResult`. `routes/` becomes thin Fresh adapters (`fresh_adapter.tsx`). Characterization stays green, and every page's normalized HTML matched a pre-refactor snapshot byte for byte (18 pages and states).
- [ ] Build the new stack alongside Fresh, unused by production:
  - island helper, boundaries, registry and mounter;
  - Hono app (`5.0.0-rc.1`, exact pin) with the four middlewares and the route table;
  - `renderPage` with manifest preloads;
  - `AssetSource` with the allowlist;
  - a separate Vite config building to `dist/`;
  - the DOM-level tests.

  Characterization then has to go green against the new app.
- [ ] Cutover commit:
  - switch the Vite config, server JSX, client entry, source-mode launcher (broad staleness plus manifest validation, serve command) and binary spec (`server_main.ts`, `--include dist`);
  - update the root and web tasks, CI (client build on all platforms), and the login and launcher tests;
  - remove `routes/`, `utils.ts`, `main.ts`, `web_app.ts`, `compiled_main.ts`, `@fresh/*` and the `fresh` lint tag;
  - regenerate the web lockfile with Deno 2.9.8 and confirm the frozen install.
- [ ] Startup test on all CI platforms.
- [ ] Update [[dev.codebase-overview]], [[dev.testing]] and [[dev.decision-log]].
- [ ] Hono release gate: pin `5.0.0` and rerun characterization, or review the v4 fixes the RC lacks and decide (see Decisions).
- [ ] Run `deno task ci`, cross-platform CI, a release rehearsal, and the manual smoke checklist.
- [ ] Release.
- [ ] Preact 11, as its own change, including an evaluation of `hydrate()`.
