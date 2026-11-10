// Characterization harness: drives a built Kato Web server in-process with an
// isolated HOME, so the suite records what users actually get without reading
// or writing the operator's real ~/.kato.
//
// Route code resolves default paths from HOME at request time, so HOME (and
// USERPROFILE on Windows) must point at a temp directory before the server is
// imported and for as long as requests run. Callers must run serially.
import { join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  createInitializedWebConfig,
  PersistentSessionStateStore,
  resolveDefaultSharedConfigPath,
  resolveDefaultWebConfigPath,
  SharedBehaviorConfigFileStore,
  WebConfigFileStore,
} from "@kato/runtime";
import {
  makeTestTempDir,
  removePathIfPresent,
} from "../../../../tests/test_temp.ts";

export const ORIGIN = "http://kato.local";
export const USERNAME = "dj";
export const PASSWORD = "secret-pass";

type FetchHandler = (
  request: Request,
  info: Deno.ServeHandlerInfo<Deno.NetAddr>,
) => Promise<Response>;

const SERVE_INFO = {
  remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 40000 },
  completed: Promise.resolve(),
} as unknown as Deno.ServeHandlerInfo<Deno.NetAddr>;

const HOME_KEYS = ["HOME", "USERPROFILE"] as const;

export interface RequestOptions {
  method?: string;
  cookie?: string;
  /** Sets `origin`; pass `null` to send no origin or referer. */
  origin?: string | null;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  body?: BodyInit;
}

/** State the mutation cases act on; created by `seedFixtures()`. */
export interface Fixtures {
  /** A workspace directory with a minimal config, not yet registered. */
  workspaceDir: string;
  workspaceAlias: string;
  /** Kato session id of a persisted session with no recordings. */
  sessionId: string;
}

export const FIXTURE_SESSION_ID = "fixture-session-0001";
export const FIXTURE_WORKSPACE_ALIAS = "fixture-ws";

export interface Harness {
  readonly configuredHome: string;
  readonly unconfiguredHome: string;
  readonly fixtures: Fixtures;
  /** Switches HOME between a configured Kato Web and an unconfigured one. */
  useHome(kind: "configured" | "unconfigured"): void;
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Logs in with the configured credentials; returns the `cookie` header. */
  login(): Promise<string>;
  /** Reads the CSRF token rendered into an authenticated page's forms. */
  csrfToken(cookie: string, path?: string): Promise<string>;
  close(): Promise<void>;
}

export interface ServerTarget {
  name: string;
  /** True for the server replacing Fresh; selects `expectReplacement`. */
  replacement: boolean;
  /** Module whose default export has `fetch(request, info)`. */
  moduleUrl: URL;
  /** Directory of the hashed client assets served under `/assets/`. */
  clientAssetsDir: URL;
  buildHint: string;
}

export const FRESH_TARGET: ServerTarget = {
  name: "fresh",
  replacement: false,
  moduleUrl: new URL("../../_fresh/server.js", import.meta.url),
  clientAssetsDir: new URL("../../_fresh/client/assets/", import.meta.url),
  buildHint: "deno task --cwd apps/web build",
};

// startWebServerStatusHeartbeat() returns early when this global is set. The
// built server starts the heartbeat on import; without the guard it would leak
// an interval into the test run and write a final status on process exit.
const HEARTBEAT_GUARD_KEY = "__katoWebStatusRuntime";

async function loadHandler(target: ServerTarget): Promise<FetchHandler> {
  try {
    await Deno.stat(target.moduleUrl);
  } catch {
    throw new Error(
      `${target.name} build output is missing (${target.moduleUrl.pathname}); run \`${target.buildHint}\` first`,
    );
  }
  const globals = globalThis as Record<string, unknown>;
  globals[HEARTBEAT_GUARD_KEY] ??= { active: false };
  const module = await import(target.moduleUrl.href);
  const server = module.default as { fetch: FetchHandler };
  return (request, info) => server.fetch(request, info);
}

export async function createHarness(
  target: ServerTarget = FRESH_TARGET,
): Promise<Harness> {
  const savedEnv = new Map(HOME_KEYS.map((key) => [key, Deno.env.get(key)]));
  const root = await makeTestTempDir("web-characterization-");
  const configuredHome = join(root, "configured");
  const unconfiguredHome = join(root, "unconfigured");
  await Deno.mkdir(configuredHome, { recursive: true });
  await Deno.mkdir(unconfiguredHome, { recursive: true });

  const setHome = (home: string) => {
    for (const key of HOME_KEYS) Deno.env.set(key, home);
  };
  setHome(configuredHome);
  const katoDir = join(configuredHome, ".kato");
  await new WebConfigFileStore(resolveDefaultWebConfigPath(katoDir))
    .ensureInitialized(
      await createInitializedWebConfig({
        hostname: "127.0.0.1",
        port: 3187,
        username: USERNAME,
        password: PASSWORD,
      }),
    );

  // Fixtures: the shared config that workspace registration needs, a
  // workspace directory to register, and one persisted provider session.
  await new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  )
    .ensureInitialized(
      createDefaultSharedBehaviorConfig({ allowedWriteRoots: [] }),
    );
  const workspaceDir = join(configuredHome, "workspace-a");
  await Deno.mkdir(join(workspaceDir, "notes"), { recursive: true });
  await Deno.writeTextFile(
    join(workspaceDir, ".kato-workspace-config.yaml"),
    "defaultOutputDir: notes\n",
  );
  const providerDir = join(configuredHome, "provider");
  await Deno.mkdir(providerDir, { recursive: true });
  const sourceFilePath = join(providerDir, "fixture.jsonl");
  await Deno.writeTextFile(sourceFilePath, "");
  const session = await new PersistentSessionStateStore({
    katoDir,
    makeSessionId: () => FIXTURE_SESSION_ID,
  }).getOrCreateSessionMetadata({
    provider: "claude",
    providerSessionId: "fixture-provider-session",
    sourceFilePath,
    initialCursor: { kind: "byte-offset", value: 0 },
  });
  const fixtures: Fixtures = {
    workspaceDir,
    workspaceAlias: FIXTURE_WORKSPACE_ALIAS,
    sessionId: session.sessionId,
  };

  const handler = await loadHandler(target);

  const request = async (path: string, options: RequestOptions = {}) => {
    const headers = new Headers(options.headers);
    if (options.cookie) headers.set("cookie", options.cookie);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers.set("origin", origin);
    let body = options.body;
    if (options.form) {
      body = new URLSearchParams(options.form);
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    return await handler(
      new Request(url, { method: options.method ?? "GET", headers, body }),
      SERVE_INFO,
    );
  };

  return {
    configuredHome,
    unconfiguredHome,
    fixtures,
    useHome(kind) {
      setHome(kind === "configured" ? configuredHome : unconfiguredHome);
    },
    request,
    async login() {
      const response = await request("/login", {
        method: "POST",
        form: { username: USERNAME, password: PASSWORD },
      });
      await response.body?.cancel();
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) {
        throw new Error(`login failed with ${response.status}`);
      }
      return setCookie.split(";")[0];
    },
    async csrfToken(cookie, path = "/settings") {
      const response = await request(path, { cookie });
      const html = await response.text();
      const input = html.match(/<input[^>]*name="csrfToken"[^>]*>/)?.[0];
      const token = input?.match(/value="([^"]+)"/)?.[1];
      if (!token) {
        throw new Error(`no CSRF token rendered on ${path}`);
      }
      return token;
    },
    async close() {
      for (const [key, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      await removePathIfPresent(root);
    },
  };
}

/** The response facts the suite compares across implementations. */
export interface ResponseFacts {
  status: number;
  contentType?: string;
  location?: string;
  cacheControl?: string;
  setCookie?: string;
  title?: string;
}

export async function responseFacts(response: Response): Promise<
  ResponseFacts & { body: string }
> {
  const body = await response.text();
  const title = body.match(/<title>([^<]*)<\/title>/)?.[1];
  const facts: ResponseFacts & { body: string } = {
    status: response.status,
    body,
  };
  const contentType = response.headers.get("content-type");
  if (contentType) facts.contentType = contentType;
  const location = response.headers.get("location");
  if (location) facts.location = location;
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl) facts.cacheControl = cacheControl;
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    // Values are random; keep the cookie name and attributes.
    facts.setCookie = setCookie.replace(/^([^=]+)=[^;]*/, "$1=<value>");
  }
  if (title !== undefined) facts.title = title;
  return facts;
}
