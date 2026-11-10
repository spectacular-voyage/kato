// Guards the browser bundle's import graph. Every island, and the client entry,
// must reach only browser-safe modules: Kato Web's own non-loader modules,
// `shared/src`, and Preact. Fresh's Vite plugin currently tree-shakes server-only
// imports away; a plain Vite build cannot, so leaks must not exist at all.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const webRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);

const ALLOWED_LOCAL_PREFIXES = [
  new URL("islands/", webRoot).href,
  new URL("src/", webRoot).href,
  new URL("client.ts", webRoot).href,
  new URL("assets/", webRoot).href,
  new URL("shared/src/", repoRoot).href,
];
const FORBIDDEN_LOCAL_PREFIXES = [new URL("src/loaders/", webRoot).href];
const ALLOWED_NPM_PACKAGES = new Set(["preact"]);

interface DenoInfoDependency {
  specifier: string;
  code?: { specifier: string };
}

interface DenoInfoModule {
  specifier: string;
  kind?: string;
  local?: string;
  error?: string;
  dependencies?: DenoInfoDependency[];
}

interface DenoInfoGraph {
  roots: string[];
  modules: DenoInfoModule[];
  redirects: Record<string, string>;
}

async function loadGraph(entry: URL): Promise<DenoInfoGraph> {
  const output = await new Deno.Command("deno", {
    args: [
      "info",
      "--json",
      "--config",
      fromFileUrl(new URL("deno.json", webRoot)),
      fromFileUrl(entry),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `deno info failed for ${entry.pathname}: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

function resolveRedirect(graph: DenoInfoGraph, specifier: string): string {
  let current = specifier;
  for (let hops = 0; hops < 10 && graph.redirects[current]; hops++) {
    current = graph.redirects[current];
  }
  return current;
}

function npmPackageName(specifier: string): string {
  // "npm:/preact@10.29.8/hooks" or "npm:/@scope/name@1.0.0/sub"
  const body = specifier.replace(/^npm:\/?/, "");
  const scoped = body.startsWith("@");
  const parts = body.split("/");
  const nameWithVersion = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
  const at = nameWithVersion.lastIndexOf("@");
  return at > 0 ? nameWithVersion.slice(0, at) : nameWithVersion;
}

/** Modules reachable from the root through runtime (non-type-only) imports. */
function reachableModules(graph: DenoInfoGraph): DenoInfoModule[] {
  const bySpecifier = new Map(graph.modules.map((m) => [m.specifier, m]));
  const seen = new Set<string>();
  const queue = graph.roots.map((root) => resolveRedirect(graph, root));
  const reached: DenoInfoModule[] = [];
  while (queue.length > 0) {
    const specifier = queue.shift()!;
    if (seen.has(specifier)) continue;
    seen.add(specifier);
    const module = bySpecifier.get(specifier) ?? { specifier };
    reached.push(module);
    for (const dependency of module.dependencies ?? []) {
      if (dependency.code) {
        queue.push(resolveRedirect(graph, dependency.code.specifier));
      }
    }
  }
  return reached;
}

async function findViolations(entry: URL): Promise<string[]> {
  const graph = await loadGraph(entry);
  const violations: string[] = [];
  for (const module of reachableModules(graph)) {
    const { specifier } = module;
    const isLocal = specifier.startsWith("file:");
    const isAllowedLocal = isLocal &&
      ALLOWED_LOCAL_PREFIXES.some((prefix) => specifier.startsWith(prefix)) &&
      !FORBIDDEN_LOCAL_PREFIXES.some((prefix) => specifier.startsWith(prefix));
    if (isAllowedLocal && specifier.endsWith(".css")) {
      // Stylesheets are bundled by Vite; deno info reports them as errors.
      continue;
    }
    if (module.error) {
      violations.push(`${specifier}: ${module.error}`);
    } else if (specifier.startsWith("npm:")) {
      if (!ALLOWED_NPM_PACKAGES.has(npmPackageName(specifier))) {
        violations.push(`${specifier}: npm package not allowed in islands`);
      }
    } else if (isLocal) {
      if (!isAllowedLocal) {
        violations.push(`${specifier}: server-only module`);
      } else if (module.local) {
        const source = await Deno.readTextFile(module.local);
        if (/\bDeno\./.test(source)) {
          violations.push(`${specifier}: uses the Deno namespace`);
        }
      }
    } else {
      violations.push(`${specifier}: not resolvable by a plain browser build`);
    }
  }
  return violations;
}

async function listEntries(): Promise<URL[]> {
  const islands = new URL("islands/", webRoot);
  const entries = [new URL("client.ts", webRoot)];
  for await (const entry of Deno.readDir(islands)) {
    if (entry.isFile && entry.name.endsWith(".tsx")) {
      entries.push(new URL(entry.name, islands));
    }
  }
  return entries.sort((a, b) => a.href.localeCompare(b.href));
}

Deno.test("island and client import graphs stay browser-safe", async () => {
  const entries = await listEntries();
  assert(entries.length > 1, "expected island entries");
  const results = await Promise.all(
    entries.map(async (entry) => ({
      entry: entry.pathname.split("/apps/web/")[1],
      violations: await findViolations(entry),
    })),
  );
  assertEquals(
    results.filter((result) => result.violations.length > 0),
    [],
  );
});
