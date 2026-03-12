import { parseArgs } from "@std/cli";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import cliDenoConfig from "../apps/cli/deno.json" with { type: "json" };
import daemonDenoConfig from "../apps/daemon/deno.json" with { type: "json" };
import webDenoConfig from "../apps/web/deno.json" with { type: "json" };

interface BinaryBuildSpec {
  name: string;
  cwd: string;
  entrypoint: string;
  permissions: string[];
  configPath?: string;
  extraArgs?: string[];
}

interface BuildMetadata {
  builtAt: string;
  target: string;
  outputDir: string;
  binaries: Array<{
    name: string;
    outputPath: string;
    entrypoint: string;
    configPath?: string;
    permissions: string[];
    extraArgs: string[];
  }>;
  versions: {
    cli: string;
    daemon: string;
    web: string;
  };
}

function readVersion(config: unknown): string {
  if (
    typeof config === "object" &&
    config !== null &&
    "version" in config &&
    typeof (config as { version?: unknown }).version === "string"
  ) {
    const value = (config as { version: string }).version.trim();
    if (value.length > 0) {
      return value;
    }
  }
  return "0.0.0-dev";
}

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function defaultTargetLabel(): string {
  return `${Deno.build.os}-${Deno.build.arch}`;
}

function resolveOutputDir(
  root: string,
  explicitOutputDir: string | undefined,
  targetLabel: string,
): string {
  if (explicitOutputDir) {
    return resolve(root, explicitOutputDir);
  }
  return join(root, ".test-tmp", "binaries", targetLabel);
}

function outputFileName(baseName: string, target: string): string {
  return target.includes("windows") ? `${baseName}.exe` : baseName;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  console.log(`$ (cd ${cwd} && ${command} ${args.join(" ")})`);
  const child = new Deno.Command(command, {
    args,
    cwd,
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

function makeBinarySpecs(root: string): BinaryBuildSpec[] {
  return [
    {
      name: "kato",
      cwd: root,
      configPath: join(root, "apps", "cli", "deno.json"),
      entrypoint: join(root, "apps", "cli", "src", "main.ts"),
      permissions: [
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-run",
      ],
    },
    {
      name: "kato-daemon",
      cwd: root,
      configPath: join(root, "apps", "daemon", "deno.json"),
      entrypoint: join(root, "apps", "daemon", "src", "main.ts"),
      permissions: [
        "--allow-read",
        "--allow-write",
        "--allow-env",
      ],
    },
    {
      name: "kato-web",
      cwd: join(root, "apps", "web"),
      entrypoint: "src/compiled_main.ts",
      permissions: [
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
      ],
      extraArgs: ["--include", "_fresh"],
    },
  ];
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/build-binaries.ts [options]",
      "",
      "Options:",
      "  --output-dir <path>    Output directory (default: .test-tmp/binaries/<host>)",
      "  --target <triple>      Optional deno compile target triple",
      "  --skip-web-install     Skip `deno install` in apps/web",
      "  --skip-web-build       Skip `deno task --cwd apps/web build`",
      "  --help                 Show this help",
    ].join("\n"),
  );
}

const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;

const parsed = parseArgs(rawArgs, {
  string: ["output-dir", "target"],
  boolean: ["skip-web-install", "skip-web-build", "help"],
  default: {
    "skip-web-install": false,
    "skip-web-build": false,
    help: false,
  },
});

if (parsed.help) {
  printUsage();
  Deno.exit(0);
}

const root = repoRoot();
const target = parsed.target ?? defaultTargetLabel();
const outputDir = resolveOutputDir(root, parsed["output-dir"], target);
await Deno.mkdir(outputDir, { recursive: true });

if (!parsed["skip-web-install"]) {
  await runCommand("deno", ["install", "--frozen"], join(root, "apps", "web"));
}

if (!parsed["skip-web-build"]) {
  await runCommand("deno", ["task", "build"], join(root, "apps", "web"));
}

const specs = makeBinarySpecs(root);
const metadata: BuildMetadata = {
  builtAt: new Date().toISOString(),
  target,
  outputDir,
  binaries: [],
  versions: {
    cli: readVersion(cliDenoConfig),
    daemon: readVersion(daemonDenoConfig),
    web: readVersion(webDenoConfig),
  },
};

for (const spec of specs) {
  const outputPath = join(outputDir, outputFileName(spec.name, target));
  const args = ["compile", "--frozen"];
  if (spec.configPath) {
    args.push("--config", spec.configPath);
  }
  if (parsed.target) {
    args.push("--target", parsed.target);
  }
  args.push(...spec.permissions);
  if (spec.extraArgs) {
    args.push(...spec.extraArgs);
  }
  args.push("--output", outputPath, spec.entrypoint);

  await runCommand("deno", args, spec.cwd);
  metadata.binaries.push({
    name: spec.name,
    outputPath,
    entrypoint: spec.entrypoint,
    configPath: spec.configPath,
    permissions: spec.permissions,
    extraArgs: spec.extraArgs ?? [],
  });
}

await Deno.writeTextFile(
  join(outputDir, "build-metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

console.log(`Built binaries into ${outputDir}`);
