import { parseArgs } from "@std/cli";
import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";

const VERSIONED_CONFIG_PATHS = [
  "apps/cli/deno.json",
  "apps/daemon/deno.json",
  "apps/web/deno.json",
] as const;

interface ReleaseNoteFrontmatter {
  id: string;
  title: string;
  desc: string;
  updated: number;
  created: number;
}

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function parseSemver(value: string): [number, number, number] {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid semver version: ${value}`);
  }
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

function formatSemver(parts: [number, number, number]): string {
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

export function incrementVersion(
  current: string,
  bump: "patch" | "minor" | "major",
): string {
  const [major, minor, patch] = parseSemver(current);
  switch (bump) {
    case "patch":
      return formatSemver([major, minor, patch + 1]);
    case "minor":
      return formatSemver([major, minor + 1, 0]);
    case "major":
      return formatSemver([major + 1, 0, 0]);
  }
}

function randomId(length = 24): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join(
    "",
  );
}

async function updateVersionedJsonFile(
  path: string,
  version: string,
): Promise<void> {
  const parsed = JSON.parse(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  parsed.version = version;
  await Deno.writeTextFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

function releaseNotesPath(root: string, version: string): string {
  return join(root, "dev-docs", "notes", `release-notes.v${version}.md`);
}

function makeReleaseNotesStub(version: string, now: Date): string {
  const timestamp = now.getTime();
  const frontmatter: ReleaseNoteFrontmatter = {
    id: randomId(),
    title: `Release Notes v${version}`,
    desc: "",
    updated: timestamp,
    created: timestamp,
  };
  return [
    "---",
    `id: ${frontmatter.id}`,
    `title: '${frontmatter.title}'`,
    `desc: '${frontmatter.desc}'`,
    `updated: ${frontmatter.updated}`,
    `created: ${frontmatter.created}`,
    "---",
    "",
  ].join("\n");
}

async function ensureReleaseNotesStub(
  root: string,
  version: string,
  now: Date,
): Promise<string> {
  const path = releaseNotesPath(root, version);
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      return path;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  await Deno.writeTextFile(path, makeReleaseNotesStub(version, now));
  return path;
}

async function readCurrentVersion(root: string): Promise<string> {
  const path = join(root, VERSIONED_CONFIG_PATHS[0]);
  const parsed = JSON.parse(await Deno.readTextFile(path)) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`Missing version in ${path}`);
  }
  return parsed.version.trim();
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/bump-version.ts [options]",
      "",
      "Options:",
      "  --version <semver>   Set an explicit version",
      "  --patch              Increment patch version",
      "  --minor              Increment minor version",
      "  --major              Increment major version",
      "  --root <path>        Repo root override (default: current repo)",
      "  --dry-run            Print the planned changes without writing files",
      "  --help               Show this help",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const parsed = parseArgs(rawArgs, {
    string: ["version", "root"],
    boolean: ["patch", "minor", "major", "dry-run", "help"],
    default: {
      patch: false,
      minor: false,
      major: false,
      "dry-run": false,
      help: false,
    },
  });

  if (parsed.help) {
    printUsage();
    Deno.exit(0);
  }

  const root = parsed.root ? resolvePath(repoRoot(), parsed.root) : repoRoot();
  const selectedBumps =
    [parsed.patch, parsed.minor, parsed.major].filter(Boolean).length;
  if (selectedBumps > 1) {
    throw new Error("Choose only one of --patch, --minor, or --major");
  }

  const currentVersion = await readCurrentVersion(root);
  const nextVersion = parsed.version
    ? formatSemver(parseSemver(parsed.version))
    : parsed.patch
    ? incrementVersion(currentVersion, "patch")
    : parsed.minor
    ? incrementVersion(currentVersion, "minor")
    : parsed.major
    ? incrementVersion(currentVersion, "major")
    : undefined;

  if (!nextVersion) {
    throw new Error("Provide --version or one of --patch/--minor/--major");
  }

  const notePath = releaseNotesPath(root, nextVersion);
  if (parsed["dry-run"]) {
    console.log(`Current version: ${currentVersion}`);
    console.log(`Next version: ${nextVersion}`);
    for (const relativePath of VERSIONED_CONFIG_PATHS) {
      console.log(`Would update ${relativePath}`);
    }
    console.log(`Would ensure ${notePath}`);
    Deno.exit(0);
  }

  for (const relativePath of VERSIONED_CONFIG_PATHS) {
    await updateVersionedJsonFile(join(root, relativePath), nextVersion);
  }
  const ensuredPath = await ensureReleaseNotesStub(
    root,
    nextVersion,
    new Date(),
  );
  console.log(`Bumped version ${currentVersion} -> ${nextVersion}`);
  console.log(`Updated ${VERSIONED_CONFIG_PATHS.length} app config files`);
  console.log(`Ensured release notes stub at ${ensuredPath}`);
}
