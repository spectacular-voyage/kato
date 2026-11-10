// What Kato Web does today, recorded from the built Fresh server on
// 2026-11-10 (see task.2026.2026-11-10-leave-fresh). The replacement server
// must produce the same results; a deliberate difference is recorded in
// `divergence` and in the task note's Contract Changes table.
//
// Expectations are framework-neutral: status, redirect target, content type,
// cache policy, title and stable text. Markup details (island markers) are not
// characterized here.

export type AuthState = "anonymous" | "authenticated" | "unconfigured";

/** What a form builder can read: fixtures and the server's own JSON views. */
export interface CaseContext {
  fixtures: { workspaceDir: string; workspaceAlias: string; sessionId: string };
  /** Selector fields of the first row in `/api/recordings`. */
  firstRecording(): Promise<Record<string, string>>;
}

export type FormBuilder = (
  context: CaseContext,
) => Record<string, string> | Promise<Record<string, string>>;

export interface Expectation {
  status: number;
  location?: string;
  /** Compared after lowercasing and removing spaces. */
  contentType?: string;
  /** `null` asserts the header is absent. */
  cacheControl?: string | null;
  title?: string;
  bodyIncludes?: string[];
  bodyEquals?: string;
  /** Top-level keys of a JSON body, in order. */
  jsonKeys?: string[];
  /** Values at dotted paths in a JSON body, e.g. `"rows.length": 1`. */
  jsonIncludes?: Record<string, unknown>;
  /** For redirects whose target embeds generated ids or counts. */
  locationMatches?: RegExp;
  setCookie?: string;
  emptyBody?: boolean;
}

export interface Case {
  name: string;
  auth: AuthState;
  method?: string;
  path: string;
  /** Authenticated non-GET requests send the CSRF token unless "none". */
  csrf?: "form" | "header" | "none";
  /** Defaults to same-origin; `null` sends no origin or referer. */
  origin?: string | null;
  /** Form fields, or a function that reads ids created by earlier cases. */
  form?: Record<string, string> | FormBuilder;
  headers?: Record<string, string>;
  expect: Expectation;
  /** Why the replacement intentionally differs; set with `expectReplacement`. */
  divergence?: string;
  expectReplacement?: Expectation;
}

export const HTML = "text/html; charset=utf-8";
export const JSON_TYPE = "application/json";
export const TEXT = "text/plain;charset=UTF-8";
export const NO_STORE = "no-store, no-cache, must-revalidate";
export const LOGIN = "http://kato.local/login";
const CROSS_ORIGIN = "http://evil.example";
const UNCONFIGURED_MESSAGE =
  "Kato Web is unconfigured. Run `kato web init --username <username>` in an interactive terminal, or provide `KATO_WEB_PASSWORD` / `--password-stdin`.";

export const title = (page: string) => `Kato Web · ${page}`;

const PAGES: Array<{ path: string; title: string; text?: string }> = [
  { path: "/", title: title("Summary") },
  { path: "/sessions", title: title("Sessions") },
  { path: "/recordings", title: title("Recordings") },
  { path: "/workspaces", title: title("Workspaces") },
  { path: "/maintenance", title: title("Maintenance") },
  { path: "/logs", title: title("Logs") },
  { path: "/settings", title: title("Settings") },
  {
    path: "/sessions/unknown-id",
    title: title("Session"),
    text: "No persisted session twin found for: unknown-id",
  },
  {
    path: "/workspaces/unknown/edit",
    title: title("Workspace Config"),
    text: "workspace not found: unknown",
  },
];

const APIS: Array<{
  path: string;
  status?: number;
  keys: string[];
  includes?: Record<string, unknown>;
}> = [
  {
    path: "/api/chrome-status",
    keys: ["daemon", "snapshot"],
    includes: { daemon: "stopped", snapshot: "current" },
  },
  {
    path: "/api/logs",
    keys: ["channel", "scope", "level", "limit", "matchedCount", "rows"],
    includes: { channel: "all", scope: "all", level: "warn", limit: 200 },
  },
  {
    path: "/api/maintenance-twins",
    keys: [
      "includeStale",
      "sessionCount",
      "currentTwinCount",
      "behindTwinCount",
      "absentTwinCount",
      "rows",
    ],
  },
  {
    path: "/api/recordings",
    keys: [
      "includeStale",
      "stateFilter",
      "activeRecordingCount",
      "staleRecordingCount",
      "stoppedRecordingCount",
      "rows",
    ],
  },
  {
    path: "/api/session-snippet",
    status: 400,
    keys: ["sessionId", "status", "error"],
    includes: {
      sessionId: "",
      status: "unavailable",
      error: "sessionId is required",
    },
  },
  {
    path: "/api/session-snippet?sessionId=x",
    keys: ["sessionId", "status"],
    includes: { sessionId: "x", status: "unavailable" },
  },
  {
    path: "/api/sessions",
    keys: [
      "includeStale",
      "workspaceOptions",
      "sessionCount",
      "activeSessionCount",
      "staleSessionCount",
      "inactiveSessionCount",
      "activeRecordingCount",
      "staleRecordingCount",
      "stoppedRecordingCount",
      "rows",
    ],
  },
  {
    path: "/api/summary",
    keys: [
      "generatedAt",
      "heartbeatAt",
      "daemon",
      "sessionCount",
      "activeSessionCount",
      "staleSessionCount",
      "generatingSessionCount",
      "staleGeneratingSessionCount",
      "inactiveSessionCount",
      "recordingCount",
      "staleRecordingCount",
      "stoppedRecordingCount",
      "sessions",
      "summarySessions",
      "providers",
      "configuredProviders",
      "stale",
      "statusPath",
      "workspaceSummary",
      "ingestionFailures",
      "recentErrors",
    ],
  },
  {
    path: "/api/workspaces",
    // `sharedConfigError` is added when the shared config is missing; the
    // harness creates one because workspace registration needs it.
    keys: ["workspaceSummary", "rows", "allowedWriteRoots"],
  },
];

const pageCases: Case[] = PAGES.flatMap((page) => [
  {
    name: `GET ${page.path} renders when signed in`,
    auth: "authenticated",
    path: page.path,
    expect: {
      status: 200,
      contentType: HTML,
      title: page.title,
      ...(page.text ? { bodyIncludes: [page.text] } : {}),
    },
  },
  {
    name: `GET ${page.path} redirects to login when signed out`,
    auth: "anonymous",
    path: page.path,
    expect: { status: 302, location: LOGIN },
  },
]);

const apiCases: Case[] = APIS.flatMap((api) => [
  {
    name: `GET ${api.path} returns JSON when signed in`,
    auth: "authenticated",
    path: api.path,
    expect: {
      status: api.status ?? 200,
      contentType: JSON_TYPE,
      cacheControl: NO_STORE,
      jsonKeys: api.keys,
      ...(api.includes ? { jsonIncludes: api.includes } : {}),
    },
  },
  {
    name: `GET ${api.path} returns 401 JSON when signed out`,
    auth: "anonymous",
    path: api.path,
    expect: {
      status: 401,
      contentType: JSON_TYPE,
      jsonIncludes: { error: "authentication required" },
    },
  },
]);

const loginCases: Case[] = [
  {
    name: "GET /login renders signed out with the layout title",
    auth: "anonymous",
    path: "/login",
    expect: { status: 200, contentType: HTML, title: "Kato Web" },
  },
  {
    name: "GET /login renders when already signed in",
    auth: "authenticated",
    path: "/login",
    expect: { status: 200, contentType: HTML, title: "Kato Web" },
  },
  {
    name: "POST /login with the right password sets the session cookie",
    auth: "anonymous",
    method: "POST",
    path: "/login",
    form: { username: "dj", password: "secret-pass" },
    expect: {
      status: 302,
      location: "/",
      setCookie:
        "kato_web_session=<value>; HttpOnly; Max-Age=43200; SameSite=Strict; Path=/",
    },
  },
  {
    name: "POST /login with a wrong password redirects with error=1",
    auth: "anonymous",
    method: "POST",
    path: "/login",
    form: { username: "dj", password: "wrong" },
    expect: { status: 302, location: `${LOGIN}?error=1` },
  },
  {
    name: "POST /login cross-origin is rejected",
    auth: "anonymous",
    method: "POST",
    path: "/login",
    origin: CROSS_ORIGIN,
    form: { username: "dj", password: "secret-pass" },
    expect: {
      status: 403,
      contentType: TEXT,
      bodyEquals: "same-origin request required",
    },
  },
  {
    name: "POST /login while signed in needs no CSRF token",
    auth: "authenticated",
    method: "POST",
    path: "/login",
    csrf: "none",
    form: { username: "dj", password: "secret-pass" },
    expect: {
      status: 302,
      location: "/",
      setCookie:
        "kato_web_session=<value>; HttpOnly; Max-Age=43200; SameSite=Strict; Path=/",
    },
  },
  {
    name: "HEAD /login renders without a body",
    auth: "authenticated",
    method: "HEAD",
    path: "/login",
    expect: { status: 200, contentType: HTML, emptyBody: true },
  },
];

const logoutCases: Case[] = [
  {
    name: "GET /logout is refused when signed in",
    auth: "authenticated",
    path: "/logout",
    expect: {
      status: 405,
      contentType: TEXT,
      bodyEquals: "logout requires POST",
    },
  },
  {
    name: "HEAD /logout is refused when signed in",
    auth: "authenticated",
    method: "HEAD",
    path: "/logout",
    expect: { status: 405, emptyBody: true },
  },
  {
    name: "GET /logout redirects to login when signed out",
    auth: "anonymous",
    path: "/logout",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "POST /logout signed out redirects to login",
    auth: "anonymous",
    method: "POST",
    path: "/logout",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "POST /logout clears the session cookie",
    auth: "authenticated",
    method: "POST",
    path: "/logout",
    expect: {
      status: 302,
      location: "/login",
      setCookie:
        "kato_web_session=<value>; HttpOnly; Max-Age=0; SameSite=Strict; Path=/",
    },
  },
];

const unconfiguredCases: Case[] = [
  ...["/", "/api/summary", "/nope"].map((path): Case => ({
    name: `GET ${path} is unavailable until Kato Web is configured`,
    auth: "unconfigured",
    path,
    expect: {
      status: 503,
      contentType: TEXT,
      bodyEquals: UNCONFIGURED_MESSAGE,
    },
  })),
  {
    name: "GET /login renders while unconfigured",
    auth: "unconfigured",
    path: "/login",
    expect: { status: 200, contentType: HTML, title: "Kato Web" },
  },
  {
    name: "POST /login is unavailable while unconfigured",
    auth: "unconfigured",
    method: "POST",
    path: "/login",
    form: { username: "dj", password: "secret-pass" },
    expect: {
      status: 503,
      contentType: TEXT,
      bodyEquals: UNCONFIGURED_MESSAGE,
    },
  },
  {
    name: "GET /brand/logo.png is served while unconfigured",
    auth: "unconfigured",
    path: "/brand/logo.png",
    expect: { status: 200, contentType: "image/png" },
  },
];

const mutationGuardCases: Case[] = [
  {
    name: "POST without a CSRF token is rejected",
    auth: "authenticated",
    method: "POST",
    path: "/settings",
    csrf: "none",
    form: {},
    expect: {
      status: 403,
      contentType: TEXT,
      bodyEquals: "csrf token required",
    },
  },
  {
    name: "POST cross-origin is rejected before the CSRF check",
    auth: "authenticated",
    method: "POST",
    path: "/settings",
    origin: CROSS_ORIGIN,
    expect: {
      status: 403,
      contentType: TEXT,
      bodyEquals: "same-origin request required",
    },
  },
  {
    name: "POST with neither origin nor referer is rejected",
    auth: "authenticated",
    method: "POST",
    path: "/settings",
    origin: null,
    expect: {
      status: 403,
      contentType: TEXT,
      bodyEquals: "same-origin request required",
    },
  },
  {
    name: "POST signed out redirects to login before any origin check",
    auth: "anonymous",
    method: "POST",
    path: "/settings",
    origin: CROSS_ORIGIN,
    form: {},
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "POST to an API signed out returns 401 JSON",
    auth: "anonymous",
    method: "POST",
    path: "/api/summary",
    expect: {
      status: 401,
      contentType: JSON_TYPE,
      jsonIncludes: { error: "authentication required" },
    },
  },
  {
    name: "HEAD skips the mutation guards",
    auth: "authenticated",
    method: "HEAD",
    path: "/sessions",
    csrf: "none",
    origin: CROSS_ORIGIN,
    expect: { status: 200, contentType: HTML, emptyBody: true },
  },
  {
    name: "HEAD signed out redirects to login",
    auth: "anonymous",
    method: "HEAD",
    path: "/settings",
    expect: { status: 302, location: LOGIN },
  },
];

// Methods a route does not define, after the auth middleware lets them through.
const methodCases: Case[] = [
  ...["PUT", "DELETE", "OPTIONS"].map((method): Case => ({
    name: `${method} on a page that defines GET and POST is not found`,
    auth: "authenticated",
    method,
    path: "/sessions",
    csrf: "header",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  })),
  ...["POST", "PUT"].map((method): Case => ({
    name: `${method} on a component-only page renders the page`,
    auth: "authenticated",
    method,
    path: "/",
    csrf: "header",
    expect: { status: 200, contentType: HTML, title: title("Summary") },
  })),
  {
    name: "POST on a component-only dynamic page renders the page",
    auth: "authenticated",
    method: "POST",
    path: "/sessions/unknown-id",
    csrf: "header",
    expect: { status: 200, contentType: HTML, title: title("Session") },
  },
  ...["POST", "OPTIONS"].map((method): Case => ({
    name: `${method} on a GET-only API is not found`,
    auth: "authenticated",
    method,
    path: "/api/summary",
    csrf: "header",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  })),
  {
    name: "PUT on logout is not found",
    auth: "authenticated",
    method: "PUT",
    path: "/logout",
    csrf: "header",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  },
  {
    name: "OPTIONS on a page without a CSRF token is rejected",
    auth: "authenticated",
    method: "OPTIONS",
    path: "/sessions",
    csrf: "none",
    expect: {
      status: 403,
      contentType: TEXT,
      bodyEquals: "csrf token required",
    },
  },
  ...["OPTIONS", "PUT"].map((method): Case => ({
    name: `${method} on /login skips CSRF and is not found`,
    auth: "authenticated",
    method,
    path: "/login",
    csrf: "none",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  })),
];

const routingCases: Case[] = [
  ...["/sessions/", "//sessions", "/sessions//"].map((path): Case => ({
    name: `GET ${path} reaches the Sessions page`,
    auth: "authenticated",
    path,
    expect: { status: 200, contentType: HTML, title: title("Sessions") },
  })),
  {
    name: "GET /api/summary/ reaches the API",
    auth: "authenticated",
    path: "/api/summary/",
    expect: { status: 200, contentType: JSON_TYPE, cacheControl: NO_STORE },
  },
  {
    name: "GET with different case is not found",
    auth: "authenticated",
    path: "/SESSIONS",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  },
  {
    name: "GET an unknown path is not found when signed in",
    auth: "authenticated",
    path: "/nope",
    expect: { status: 404, contentType: TEXT, bodyEquals: "Not Found" },
  },
  {
    name: "GET an unknown path redirects to login when signed out",
    auth: "anonymous",
    path: "/nope",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "A percent-encoded space in a param is decoded",
    auth: "authenticated",
    path: "/sessions/a%20b",
    expect: {
      status: 200,
      title: title("Session"),
      bodyIncludes: ["No persisted session twin found for: a b"],
    },
  },
  {
    name: "A percent-encoded slash in a param stays encoded",
    auth: "authenticated",
    path: "/sessions/a%2Fb",
    expect: {
      status: 200,
      title: title("Session"),
      bodyIncludes: ["No persisted session twin found for: a%2Fb"],
    },
  },
  {
    name: "A percent-encoded slash in the workspace param stays encoded",
    auth: "authenticated",
    path: "/workspaces/a%2Fb/edit",
    expect: {
      status: 200,
      title: title("Workspace Config"),
      bodyIncludes: ["workspace not found: a%2Fb"],
    },
  },
];

const BRAND_CACHE = "no-cache, no-store, max-age=0, must-revalidate";

const brandCases: Case[] = [
  {
    name: "GET /brand/logo.png is public",
    auth: "anonymous",
    path: "/brand/logo.png",
    expect: {
      status: 200,
      contentType: "image/png",
      cacheControl: BRAND_CACHE,
    },
  },
  {
    name: "GET /brand/wordmark.png is public",
    auth: "anonymous",
    path: "/brand/wordmark.png",
    expect: {
      status: 200,
      contentType: "image/png",
      cacheControl: BRAND_CACHE,
    },
  },
  {
    name: "HEAD /brand/logo.png is public",
    auth: "anonymous",
    method: "HEAD",
    path: "/brand/logo.png",
    expect: {
      status: 200,
      contentType: "image/png",
      cacheControl: BRAND_CACHE,
      emptyBody: true,
    },
  },
  ...["POST", "PUT", "OPTIONS"].map((method): Case => ({
    name: `${method} /brand/logo.png is not allowed`,
    auth: "anonymous",
    method,
    path: "/brand/logo.png",
    expect: { status: 405, contentType: TEXT },
  })),
  {
    name: "Legacy GET /brand/logo redirects to the PNG when signed in",
    auth: "authenticated",
    path: "/brand/logo",
    expect: { status: 307, location: "http://kato.local/brand/logo.png" },
  },
  {
    name: "Legacy GET /brand/logo redirects to login when signed out",
    auth: "anonymous",
    path: "/brand/logo",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "Legacy GET /brand/<unknown> is not found when signed in",
    auth: "authenticated",
    path: "/brand/nope",
    expect: { status: 404, contentType: TEXT, bodyEquals: "not found" },
  },
  {
    name: "A missing asset falls through to auth",
    auth: "anonymous",
    path: "/assets/nope.js",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "A traversal path falls through to auth",
    auth: "anonymous",
    path: "/assets/..%2f..%2fdeno.json",
    expect: { status: 302, location: LOGIN },
  },
  {
    name: "An encoded separator in a static path",
    auth: "anonymous",
    path: "/brand%2flogo.png",
    expect: {
      status: 200,
      contentType: "image/png",
      cacheControl: BRAND_CACHE,
    },
    divergence:
      "Fresh decodes %2f before looking up static files. The replacement serves only exact allowlisted paths, so the request falls through to auth.",
    expectReplacement: { status: 302, location: LOGIN },
  },
];

export const READ_CASES: Case[] = [
  ...pageCases,
  ...apiCases,
  ...loginCases,
  ...logoutCases,
  ...unconfiguredCases,
  ...mutationGuardCases,
  ...methodCases,
  ...routingCases,
  ...brandCases,
];

/** Built client assets: one stylesheet and the entry script, found per build. */
export const ASSET_CACHE = "public, max-age=31536000, immutable";
