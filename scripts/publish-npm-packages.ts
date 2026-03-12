import { parseArgs } from "@std/cli";
import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";

interface NpmPackagesMetadata {
  createdAt: string;
  version: string;
  wrapperPackageName: string;
  platformPackagePrefix: string;
  commandName: string;
  wrapperDir: string;
  platformPackages: Array<{
    packageName: string;
    label: string;
    target: string;
    packageDir: string;
    os: string;
    cpu: string;
    libc?: string;
    executablePath: string;
  }>;
}

export interface NpmPublishTarget {
  packageName: string;
  packageDir: string;
}

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function readMetadata(path: string): Promise<NpmPackagesMetadata> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as NpmPackagesMetadata;
}

export function publicationOrder(
  metadata: NpmPackagesMetadata,
): NpmPublishTarget[] {
  return [
    ...metadata.platformPackages
      .slice()
      .sort((left, right) => left.packageName.localeCompare(right.packageName))
      .map((entry) => ({
        packageName: entry.packageName,
        packageDir: entry.packageDir,
      })),
    {
      packageName: metadata.wrapperPackageName,
      packageDir: metadata.wrapperDir,
    },
  ];
}

async function resolveDownloadedPath(
  inputDir: string,
  preferredPath: string,
  fallbackPath?: string,
): Promise<string> {
  const candidates = [
    preferredPath,
    join(inputDir, preferredPath.split(/[\\/]/).at(-1) ?? preferredPath),
    ...(fallbackPath ? [fallbackPath] : []),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await Deno.stat(candidate);
      if (stat.isDirectory) {
        return candidate;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
  throw new Error(
    `Could not resolve downloaded npm package path for ${preferredPath} under ${inputDir}`,
  );
}

export async function resolvedPublicationOrder(
  metadata: NpmPackagesMetadata,
  inputDir: string,
): Promise<NpmPublishTarget[]> {
  const ordered = publicationOrder(metadata);
  const resolvedTargets = await Promise.all(
    ordered.map(async (target, index) => {
      const fallbackPath = index === ordered.length - 1
        ? join(inputDir, "wrapper")
        : join(
          inputDir,
          "platforms",
          target.packageDir.split(/[\\/]/).at(-1) ?? target.packageName,
        );
      return {
        packageName: target.packageName,
        packageDir: await resolveDownloadedPath(
          inputDir,
          target.packageDir,
          fallbackPath,
        ),
      };
    }),
  );
  return resolvedTargets;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  console.log(`$ (cd ${cwd} && ${command} ${args.join(" ")})`);
  const child = new Deno.Command(command, {
    args,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  if (!status.success) {
    throw new Error(
      `Command failed with exit code ${status.code}: ${command} ${
        args.join(" ")
      }`,
    );
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/publish-npm-packages.ts [options]",
      "",
      "Options:",
      "  --input-dir <path>    npm package assembly output dir (default: .test-tmp/npm-packages/release)",
      "  --npm-bin <path>      npm executable to use (default: npm)",
      "  --tag <name>          npm dist-tag to publish under (default: latest)",
      "  --dry-run             Run `npm publish --dry-run` instead of a real publish",
      "  --help                Show this help",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const parsed = parseArgs(rawArgs, {
    string: ["input-dir", "npm-bin", "tag"],
    boolean: ["dry-run", "help"],
    default: {
      help: false,
      "dry-run": false,
      "npm-bin": "npm",
      tag: "latest",
    },
  });

  if (parsed.help) {
    printUsage();
    Deno.exit(0);
  }

  const root = repoRoot();
  const inputDir = parsed["input-dir"]
    ? resolvePath(root, parsed["input-dir"])
    : join(root, ".test-tmp", "npm-packages", "release");
  const npmBin = parsed["npm-bin"];
  const tag = parsed.tag;
  if (!npmBin || !tag) {
    throw new Error("--npm-bin and --tag are required");
  }

  const metadata = await readMetadata(
    join(inputDir, "npm-packages-metadata.json"),
  );
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (value !== undefined) {
      baseEnv[key] = value;
    }
  }
  baseEnv.PATH = `${dirname(npmBin)}${baseEnv.PATH ? `:${baseEnv.PATH}` : ""}`;

  for (const target of await resolvedPublicationOrder(metadata, inputDir)) {
    const args = ["publish", "--tag", tag];
    if (parsed["dry-run"]) {
      args.push("--dry-run");
    } else {
      args.push("--provenance");
    }
    await runCommand(npmBin, args, target.packageDir, baseEnv);
  }
}
