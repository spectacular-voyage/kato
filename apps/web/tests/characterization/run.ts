// Runs the characterization cases against one server target.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createHarness,
  type Harness,
  type RequestOptions,
  responseFacts,
  type ServerTarget,
} from "./harness.ts";
import {
  ASSET_CACHE,
  type Case,
  type CaseContext,
  type Expectation,
  READ_CASES,
} from "./cases.ts";
import { MUTATION_CASES } from "./mutation_cases.ts";

export const CASES: Case[] = [...READ_CASES, ...MUTATION_CASES];

function normalizeContentType(value: string | undefined): string | undefined {
  return value?.toLowerCase().replaceAll(" ", "");
}

/** Visible page text: scripts and tags removed, entities decoded. */
export function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

function caseContext(harness: Harness): CaseContext {
  return {
    fixtures: harness.fixtures,
    async firstRecording() {
      const cookie = await harness.login();
      const response = await harness.request("/api/recordings", { cookie });
      const row = (await response.json()).rows?.[0];
      if (!row) throw new Error("no recording row to act on");
      return {
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        outputPath: row.outputPath,
        recordingCycleId: row.recordingCycleId,
      };
    },
  };
}

async function buildRequest(
  harness: Harness,
  testCase: Case,
): Promise<RequestOptions> {
  const method = testCase.method ?? "GET";
  const form = typeof testCase.form === "function"
    ? await testCase.form(caseContext(harness))
    : testCase.form;
  const options: RequestOptions = {
    method,
    origin: testCase.origin,
    form,
    headers: { ...testCase.headers },
  };
  if (testCase.auth === "authenticated") {
    // A fresh session per case, so logout or login cases cannot affect others.
    options.cookie = await harness.login();
    const mutating = method !== "GET" && method !== "HEAD";
    const csrf = testCase.csrf ?? "form";
    if (mutating && csrf !== "none") {
      const token = await harness.csrfToken(options.cookie);
      if (csrf === "header") {
        options.headers!["x-kato-csrf"] = token;
      } else {
        options.form = { ...form, csrfToken: token };
      }
    }
  }
  return options;
}

async function check(
  response: Response,
  expected: Expectation,
): Promise<void> {
  const facts = await responseFacts(response);
  assertEquals(facts.status, expected.status, "status");
  if (expected.location !== undefined) {
    assertEquals(facts.location, expected.location, "location");
  }
  if (expected.locationMatches !== undefined) {
    assert(
      expected.locationMatches.test(facts.location ?? ""),
      `location ${facts.location} should match ${expected.locationMatches}`,
    );
  }
  if (expected.contentType !== undefined) {
    assertEquals(
      normalizeContentType(facts.contentType),
      normalizeContentType(expected.contentType),
      "content-type",
    );
  }
  if (expected.cacheControl !== undefined) {
    assertEquals(
      facts.cacheControl ?? null,
      expected.cacheControl,
      "cache-control",
    );
  }
  if (expected.title !== undefined) {
    assertEquals(facts.title, expected.title, "title");
  }
  if (expected.setCookie !== undefined) {
    assertEquals(facts.setCookie, expected.setCookie, "set-cookie");
  }
  if (expected.emptyBody) {
    assertEquals(facts.body, "", "body");
  }
  if (expected.bodyEquals !== undefined) {
    assertEquals(facts.body, expected.bodyEquals, "body");
  }
  if (expected.bodyIncludes) {
    const text = facts.contentType?.startsWith("text/html")
      ? textOf(facts.body)
      : facts.body;
    for (const snippet of expected.bodyIncludes) {
      assert(
        text.includes(snippet),
        `body should include ${JSON.stringify(snippet)}`,
      );
    }
  }
  if (expected.jsonKeys || expected.jsonIncludes) {
    const json = JSON.parse(facts.body) as Record<string, unknown>;
    if (expected.jsonKeys) {
      assertEquals(Object.keys(json), expected.jsonKeys, "JSON keys");
    }
    for (const [path, value] of Object.entries(expected.jsonIncludes ?? {})) {
      const actual = path.split(".").reduce<unknown>(
        (current, key) =>
          current === null || current === undefined
            ? undefined
            : (current as Record<string, unknown>)[key],
        json,
      );
      assertEquals(actual, value, `JSON ${path}`);
    }
  }
}

async function firstAsset(dir: URL, pattern: RegExp): Promise<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && pattern.test(entry.name)) return entry.name;
  }
  throw new Error(`no asset matching ${pattern} in ${dir.pathname}`);
}

async function checkAssets(
  t: Deno.TestContext,
  harness: Harness,
  target: ServerTarget,
): Promise<void> {
  const assets: Array<[string, RegExp, string]> = [
    ["stylesheet", /\.css$/, "text/css; charset=UTF-8"],
    [
      "client entry script",
      /^client-entry-.*\.js$/,
      "text/javascript; charset=UTF-8",
    ],
  ];
  for (const [label, pattern, contentType] of assets) {
    const name = await firstAsset(target.clientAssetsDir, pattern);
    const path = `/assets/${name}`;
    const size = (await Deno.stat(new URL(name, target.clientAssetsDir))).size;
    let etag = "";
    await t.step(`GET the built ${label} is public and immutable`, async () => {
      const response = await harness.request(path);
      etag = response.headers.get("etag") ?? "";
      assertEquals(response.headers.get("vary"), "If-None-Match", "vary");
      assertEquals(
        response.headers.get("content-length"),
        String(size),
        "content-length",
      );
      assert(/^W\/"[0-9a-f]+"$/.test(etag), `weak etag, got ${etag}`);
      await check(response, {
        status: 200,
        contentType,
        cacheControl: ASSET_CACHE,
      });
    });
    await t.step(
      `GET the built ${label} with its ETag is not modified`,
      async () => {
        const response = await harness.request(path, {
          headers: { "if-none-match": etag },
        });
        await check(response, { status: 304, emptyBody: true });
      },
    );
    await t.step(`HEAD the built ${label} has no body`, async () => {
      const response = await harness.request(path, { method: "HEAD" });
      await check(response, {
        status: 200,
        contentType,
        cacheControl: ASSET_CACHE,
        emptyBody: true,
      });
    });
  }
}

export async function runCharacterization(
  t: Deno.TestContext,
  target: ServerTarget,
  cases: Case[] = CASES,
): Promise<void> {
  const harness = await createHarness(target);
  try {
    for (const testCase of cases) {
      const expected = target.replacement && testCase.expectReplacement
        ? testCase.expectReplacement
        : testCase.expect;
      await t.step(testCase.name, async () => {
        harness.useHome(
          testCase.auth === "unconfigured" ? "unconfigured" : "configured",
        );
        const options = await buildRequest(harness, testCase);
        await check(await harness.request(testCase.path, options), expected);
      });
    }
    harness.useHome("configured");
    await checkAssets(t, harness, target);
  } finally {
    await harness.close();
  }
}
