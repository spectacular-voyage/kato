---
id: 5rbmfysnpl285dpkzrflnnx
title: Leave Fresh
desc: Replace Fresh 2 in Kato Web with Hono routing, server-rendered Preact pages, a small in-repo island hydrator, and a plain Vite client build, without changing what users see.
updated: 1794334438105
created: 1794334438105
---

## Goal

Kato Web runs without Fresh, on Deno 2.9, with the same pages, forms, live polling, auth, and URLs. No `@fresh/*` package remains in any lockfile. The server code no longer needs a build step, and the client build is plain Vite. This is stage 1 of [[task.2026.2026-11-10-platform-migration]].

## Summary

How Kato Web uses Fresh today (2026-11-10):

- **App wiring** (`apps/web/web_app.ts`): one Fresh `App` with four middlewares in order: error logging, `staticFiles()`, state init (`appName`, `authenticated`, `csrfToken`, `pathname`), and auth (session cookie, same-origin check, CSRF on authenticated non-GET requests, 401 JSON for `/api/*`, 302 to `/login` for pages, 503 when unconfigured). Then `app.fsRoutes()`.
- **Routes** (`apps/web/routes/`): 20 files.
  - 10 pages, 7 of them with a `POST` handler.
  - 8 `/api/*` JSON endpoints.
  - `logout` (POST only) and a legacy `/brand/:asset` redirect.
  - The layout is `_app.tsx`.
- **Route API surface is narrow:** routes use only `ctx.req`, `ctx.url`, `ctx.params` (3 dynamic routes) and `ctx.state.csrfToken`. Pages are `async` components that load their own data; each sets its title with Fresh's `<Head>`. POST handlers already delegate to framework-free functions in `apps/web/src` that take a `Request`.
- **Islands:** seven components cross the server/client boundary:
  - `SummaryLive`, `SessionsLive`, `RecordingsLive`, `WorkspacesLive`, `MaintenanceTwinsLive` (one per page);
  - `HeaderStatusLive` (inside `AppHeader`, on every page);
  - `LogsResultsLive` (inside `LogPageView`).

  Their props are JSON data, endpoint strings, an optional CSRF token, and numbers/booleans. No island receives JSX children or functions. The other modules in `islands/` (`SessionSnippet`, hooks, `auth_expiry.ts`) are only ever used inside islands.
- **Build:** `vite build` with `@fresh/plugin-vite` produces `_fresh/server.js` plus `_fresh/client/` (CSS, island chunks, and `static/brand/*`).
  - **Source mode:** `kato web start` runs that build when anything under `apps/web`, `apps/runtime/src` or `shared/src` is newer than `_fresh/server.js`, then `deno serve -A _fresh/server.js`.
  - **Binary:** `kato-web` is compiled from `src/compiled_main.ts` with `--include _fresh`.
- **The client graph leaks server code:**
  - `src/log_results.tsx` and `src/log_page.tsx` import `DEFAULT_LOG_LEVEL_FILTER` from the server loader `src/loaders/logs.ts`, which imports `@kato/runtime` and `jsr:@std/path`.
  - `src/session_routes.ts` imports `hashStringFNV1a` from `@kato/runtime`.

  Fresh's Vite plugin resolves Deno specifiers and tree-shakes the leak away; plain Vite cannot resolve them.
- **Tests:** only `apps/web/tests/auth_redirect_test.ts` exercises the assembled app; `login_page_test.tsx` renders one route component. Route wiring, middleware order, and static serving are otherwise untested.

## Design

### Server

- **Hono 4** via `npm:hono@^4` (v5 is a release candidate since 2026-10-08; upgrade after it ships).
  - Kato uses only the core: routing, middleware, `c.req`, and `app.request()` in tests.
  - It uses no runtime adapters (`hono/deno`, `serveStatic`), so v5's adapter split and a later runtime switch don't touch it.
- **Entry:** `apps/web/server.ts` exports `createWebApp(options)`, returning the Hono app. `apps/web/src/server_main.ts` (renamed from `compiled_main.ts`) parses `--host` and `--port` as today and calls `Deno.serve(app.fetch)`. Source mode and the compiled binary use the same entry, so the `deno serve _fresh/server.js` path disappears.
- **Middleware order is unchanged:**
  1. error logging (`app.onError`, which logs and returns a plain 500);
  2. static assets;
  3. state init;
  4. auth.

  Public, pre-auth paths are the built assets (`/assets/*`), `/brand/*`, and `/login`, as today. The auth middleware's `/_fresh/` exemption (Fresh's internal paths) goes away.
- **Routing is an explicit table,** `apps/web/app_routes.ts`, one line per route (`/sessions/:sessionId`, `/workspaces/:workspaceId/edit`, …), instead of file-based routing.

### Routes

- A Kato-owned context, `apps/web/src/route_context.ts`:

  ```ts
  interface RouteContext {
    req: Request;
    url: URL;
    params: Record<string, string>;
    state: { appName: string; authenticated: boolean; csrfToken?: string; pathname: string };
  }
  ```

  The Hono adapter builds it from `c`. Route modules depend on this type, not on Hono or Fresh.
- Route modules move from `routes/` to `apps/web/pages/` and export plain functions:
  - `GET`/`POST` handlers: `(ctx: RouteContext) => Response | Promise<Response>`.
  - `page`: `(ctx: RouteContext) => Promise<PageResult | Response>`, where `PageResult` is `{ title: string; body: VNode }`. The page loads its data, then returns a synchronously renderable tree. This replaces both async components (which synchronous `preact-render-to-string` cannot await) and `<Head>`.
  - Returning a `Response` covers the pages that redirect.
- **Rendering:** `renderPage(ctx, result)` returns `"<!DOCTYPE html>" + renderToString(<Layout …>{body}</Layout>)` as `text/html; charset=utf-8`.
  - `Layout` is today's `_app.tsx` markup, with the page title in `<title>`.
  - It also adds the client stylesheet and entry script, both resolved from the Vite manifest.

### Islands

- **Server side:** `island(name, Component)` in `apps/web/src/island.tsx` wraps a boundary component. It renders:
  - `<kato-island data-island="Name" data-props="n">…server markup…</kato-island>`;
  - followed by `<script type="application/json" id="kato-island-props-n">…</script>`.

  `kato-island { display: contents }` keeps layout identical. The CSS has no child combinators that target island roots; its structural selectors all sit inside island markup.
- **Props:** serialized with `JSON.stringify`, then `<` escaped as `<` so no prop can close the script tag. Island props already round-trip as JSON today, because each island's `initialData` has the same type its polling endpoint returns via `Response.json`.
- **Wrapped boundaries:** routes and `AppHeader`/`LogPageView` import the wrapped versions from one module, `apps/web/src/island_boundaries.tsx`. Island files themselves don't change.
- **Client side:** `client.ts` imports the stylesheet and a registry of `name → () => import("./islands/Name.tsx")`. On load it finds each `kato-island`, reads its props script, and calls `hydrate(h(Component, props), element)`. Dynamic imports keep one chunk per island, as now.

### Client build

- **Vite only, with no framework plugin:**
  - `esbuild` JSX set to `automatic` with `jsxImportSource: "preact"`;
  - `resolve.alias` maps `@kato/shared` to `shared/src/mod.ts`;
  - `publicDir: "static"`;
  - `build.manifest: true`;
  - `outDir: "dist"`;
  - input `client.ts`.

  `dist/` holds `assets/*` (hashed) and `brand/*`. `preact` and `preact/hooks` resolve from `apps/web/node_modules` (`nodeModulesDir: "auto"`).
- **The client graph must stay server-free:**
  - Move `DEFAULT_LOG_LEVEL_FILTER` to a client-safe module.
  - Move `apps/runtime/src/utils/hash.ts` (no imports) to `shared/src`, re-exported from `@kato/runtime` so its five existing importers keep working.
  - A guard test walks value imports from `islands/` and fails on `@kato/runtime`, `jsr:`, `npm:` other than `preact`, and `Deno.`.
- **Server-side JSX:** `apps/web/deno.json` moves from `"jsx": "precompile"` (Deno-only) to `"jsx": "react-jsx"` with `"jsxImportSource": "preact"`, and drops `jsxPrecompileSkipElements`.

### Assets

- **Lookup interface:** an `AssetSource` (`get(path) → { body, contentType, immutable } | undefined`) backs both the static middleware and the manifest lookup. Its stage 1 implementation reads `dist/` relative to the module, which works from source and inside `deno compile --include dist`.
- **Caching:** hashed `/assets/*` files get `cache-control: public, max-age=31536000, immutable`. `brand/*` gets a short max-age.
- **Later runtimes:** an embedded implementation (a generated path-to-bytes module) is a stage 3 concern for Bun or Node binaries. The interface is what keeps it swappable.

### Launcher and binary

- **Source mode** (`apps/runtime/src/web/mod.ts`):
  - **Staleness:** only the client inputs need a build check now: `islands/`, `src/`, `assets/`, `client.ts`, `vite.config.ts` and `shared/src`, compared against `dist/.vite/manifest.json`.
  - **Serve:** both the shell and PowerShell paths run `deno run --node-modules-dir=auto -A src/server_main.ts --host … --port …`.
  - **Build-latency reporting:** stays.
- **`scripts/build-binaries.ts`:** `kato-web` compiles `src/server_main.ts` with `--include dist`. Permissions are unchanged (`--allow-read --allow-write --allow-env --allow-net`).
- **Tasks and config:**
  - `apps/web/deno.json`: `build` = `vite build`; `dev` runs `vite build --watch` and `deno run --watch` on the server entry together; `start` and `update` are removed.
  - Lint drops the `fresh` rule tag; excludes move from `_fresh` to `dist`.
  - `.gitignore` gains `apps/web/dist`.
- **CI:** `ci:quality` gains `deno task --cwd apps/web build`, so a client build that cannot resolve an import fails CI. Today it only fails at release or at first `kato web start`.

## Decisions

- Keep Kato Web server-rendered with post/redirect/get forms; do not convert it into a single-page app.
- Hono rather than a hand-written router: about 20 routes, three params, and four middlewares would fit in under 100 lines over `URLPattern`, but Hono is zero-dependency, runtime-neutral, and provides `app.request()` for tests. The route modules don't import it, so replacing it later stays cheap.
- Island markers are wrapper elements with `display: contents`, not Fresh-style comment markers. Comment-marker hydration needs a fake-parent trick; wrapper elements hydrate with plain `hydrate(vnode, element)`.
- Embed `dist/` with `--include` on Deno now; defer a generated asset module to stage 3 behind `AssetSource`. (The platform migration note originally put the generated module in stage 1.)
- Stay on Preact 10 for the swap; upgrade to Preact 11 as a separate change afterwards.
- Out of this stage: replacing `@std/http/cookie` and other `@std/*` imports (stage 2), and Node portability of the server (stage 2).

## Contract Changes

No persisted-data, config, CLI, or API-response changes. Observable differences:

| Area | Fresh today | After |
|---|---|---|
| Built asset URLs | `/assets/*` with Fresh's chunk names (`client-entry-*`, `fresh-island__*`) | `/assets/*` with Vite's default names; hashes change every build either way. `/brand/*` unchanged |
| Unknown path | Fresh's 404 page | 404 with a plain-text body |
| Unhandled error | Fresh's 500 page, after logging | 500 with a plain-text body, after logging |
| Source-mode start | Builds server and client bundles; `deno serve _fresh/server.js` | Builds the client only when stale; `deno run src/server_main.ts` |
| Developer `dev` task | Vite dev server with HMR | Client rebuild on change plus server restart; reload the browser |

## Testing

Characterization tests come first, written against the current Fresh app (`createWebApp().handler()`) and kept framework-neutral: each takes a `(Request) => Promise<Response>`. The same suite then runs against the Hono app. Fixture: a temp `katoDir` with an initialized web config, and a session cookie from a real `POST /login`.

- **Auth:**
  - unauthenticated page → 302 `/login`;
  - unauthenticated `/api/*` → 401 JSON;
  - unconfigured → 503;
  - `/login` reachable without a session.
- **Mutation guards:**
  - cross-origin POST → 403 `same-origin request required`;
  - authenticated POST without a CSRF token → 403 `csrf token required`;
  - `GET /logout` → 405;
  - `POST /logout` → 302 and a cleared cookie.
- **Pages:** every page route returns 200 `text/html` when authenticated, with the expected `<title>`, a single `<!DOCTYPE html>`, and the island marker and props script for its island(s). This covers the two dynamic routes with an unknown id, which render the in-page "not found" state.
- **API:** every `/api/*` route returns 200 JSON with the live cache-control header.
- **Static:**
  - `/brand/logo.png` returns 200 without a session;
  - legacy `/brand/logo` → 307;
  - built CSS and JS resolve from the page's own links.
- **Other:** unknown path → 404, and HEAD on a page → 200 with no body.
- **Hydrator unit tests:**
  - props round-trip;
  - `</script>` inside a string prop stays inert;
  - multiple instances of the same island get distinct ids.
- **Client-graph guard test:** described under Client build.

Manual smoke test before release, from source and from the compiled binary on galactica:
- each page renders and polls;
- a recording start/stop round trip;
- a settings change;
- a workspace config edit;
- login/logout;
- an expired-session redirect from a polling island;
- `kato web start`, `status` and `stop`.

## Open Issues

- **`HEAD` handling:** Fresh's exact behavior for `HEAD` and for methods a route doesn't define (405 or 404) is to be pinned down by the characterization tests, then matched or deliberately changed.
- **Hydration mismatches:** islands whose first client render differs from the server render (for example, the browser time zone) currently re-render after hydration under Fresh; confirm the same under plain `hydrate()`.
- **Security headers:** Kato Web sets none (no CSP or frame options). It's out of scope here; noted because the new layout makes adding them easy.

## Implementation Plan

- [ ] Characterization suite against the Fresh app (framework-neutral handler), green on Fresh.
- [ ] Client-graph hygiene: move `DEFAULT_LOG_LEVEL_FILTER`; move `hash.ts` to `shared/src` with a runtime re-export; add the guard test.
- [ ] Extract page and handler logic from `routes/` into `apps/web/pages/` against `RouteContext` and `PageResult`; leave `routes/` as thin Fresh adapters; characterization still green.
- [ ] Island helper, boundary wrappers, client registry, and hydrator unit tests.
- [ ] Hono app with the four middlewares, the route table, `renderPage`, and `AssetSource`; characterization suite green against Hono.
- [ ] Vite config without the Fresh plugin; server JSX to `react-jsx`; `dist/` output; `.gitignore`.
- [ ] Source-mode launcher (staleness, serve command) and `build-binaries.ts` (`server_main.ts`, `--include dist`).
- [ ] Remove `routes/`, `utils.ts`, `main.ts`, `_fresh` handling, `@fresh/*`, and the `fresh` lint tag; regenerate the web lockfile with Deno 2.9.8 and confirm the frozen install.
- [ ] Add the web client build to `ci:quality`; update [[dev.codebase-overview]], [[dev.testing]], and [[dev.decision-log]].
- [ ] `deno task ci`; cross-platform CI; release rehearsal; manual smoke test on galactica from source and from the binary.
- [ ] Release.
- [ ] Preact 11, as its own change.
