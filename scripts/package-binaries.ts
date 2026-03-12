import { parseArgs } from "@std/cli";
import {
  basename,
  dirname,
  extname,
  fromFileUrl,
  isAbsolute,
  join,
  resolve,
} from "@std/path";

interface BuildMetadata {
  builtAt: string;
  target: string;
  outputDir: string;
  binaries: Array<{
    name: string;
    outputPath: string;
  }>;
  versions: {
    cli: string;
    daemon: string;
    web: string;
  };
}

interface BundleMetadata {
  createdAt: string;
  version: string;
  label: string;
  buildMetadataPath: string;
  bundleDir: string;
  archivePath: string;
  checksumPath: string;
  files: string[];
}

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function defaultLabelForTarget(target: string): string {
  switch (target) {
    case "linux-x86_64":
      return "linux-x64";
    case "windows-x86_64":
      return "windows-x64";
    case "darwin-x86_64":
      return "macos-x64";
    case "darwin-aarch64":
      return "macos-arm64";
    default:
      return target.replaceAll("_", "-");
  }
}

function archiveExtension(label: string): ".zip" | ".tar.gz" {
  return label.startsWith("windows-") ? ".zip" : ".tar.gz";
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

async function readBuildMetadata(path: string): Promise<BuildMetadata> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as BuildMetadata;
}

function requireUnifiedVersion(metadata: BuildMetadata): string {
  const values = [
    metadata.versions.cli,
    metadata.versions.daemon,
    metadata.versions.web,
  ];
  const unique = new Set(values);
  if (unique.size !== 1) {
    throw new Error(
      `Version mismatch in build metadata: cli=${metadata.versions.cli}, daemon=${metadata.versions.daemon}, web=${metadata.versions.web}`,
    );
  }
  return values[0];
}

async function ensureCleanDir(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  });
  await Deno.mkdir(path, { recursive: true });
}

async function copyFile(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(src, dest);
}

async function writeChecksum(path: string, contentPath: string): Promise<void> {
  const bytes = await Deno.readFile(contentPath);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  await Deno.writeTextFile(path, `${hex}  ${basename(contentPath)}\n`);
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

async function createArchive(
  bundleDir: string,
  archivePath: string,
  label: string,
): Promise<void> {
  await Deno.remove(archivePath).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  });

  const cwd = dirname(bundleDir);
  const bundleName = basename(bundleDir);
  if (archiveExtension(label) === ".zip") {
    const script = `Compress-Archive -Path '${bundleName}' -DestinationPath '${
      basename(archivePath)
    }' -Force`;
    await runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      cwd,
    );
    return;
  }

  await runCommand(
    "tar",
    ["-czf", archivePath, "-C", cwd, bundleName],
    cwd,
  );
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/package-binaries.ts --input-dir <path> [options]",
      "",
      "Options:",
      "  --input-dir <path>   Directory produced by scripts/build-binaries.ts",
      "  --output-dir <path>  Output directory (default: .test-tmp/bundles/<label>)",
      "  --label <name>       Platform label override (default: inferred from build metadata)",
      "  --help               Show this help",
    ].join("\n"),
  );
}

const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
const parsed = parseArgs(rawArgs, {
  string: ["input-dir", "output-dir", "label"],
  boolean: ["help"],
  default: { help: false },
});

if (parsed.help) {
  printUsage();
  Deno.exit(0);
}

const root = repoRoot();
const inputDirArg = parsed["input-dir"];
if (!inputDirArg) {
  throw new Error("--input-dir is required");
}

const inputDir = resolvePath(root, inputDirArg);
const buildMetadataPath = join(inputDir, "build-metadata.json");
const buildMetadata = await readBuildMetadata(buildMetadataPath);
const version = requireUnifiedVersion(buildMetadata);
const label = parsed.label ?? defaultLabelForTarget(buildMetadata.target);
const outputDir = parsed["output-dir"]
  ? resolvePath(root, parsed["output-dir"])
  : join(root, ".test-tmp", "bundles", label);

await ensureCleanDir(outputDir);

const bundleName = `kato-v${version}-${label}`;
const bundleDir = join(outputDir, bundleName);
await Deno.mkdir(bundleDir, { recursive: true });

const bundleFiles: string[] = [];
for (const binary of buildMetadata.binaries) {
  const targetPath = join(bundleDir, basename(binary.outputPath));
  await copyFile(binary.outputPath, targetPath);
  bundleFiles.push(basename(targetPath));
}

for (const extra of ["README.md", "LICENSE", "build-metadata.json"]) {
  const sourcePath = extra === "build-metadata.json"
    ? buildMetadataPath
    : join(root, extra);
  const targetPath = join(bundleDir, basename(extra));
  await copyFile(sourcePath, targetPath);
  bundleFiles.push(basename(targetPath));
}

const ext = archiveExtension(label);
const archivePath = join(outputDir, `${bundleName}${ext}`);
await createArchive(bundleDir, archivePath, label);
const checksumPath = `${archivePath}.sha256`;
await writeChecksum(checksumPath, archivePath);

const bundleMetadata: BundleMetadata = {
  createdAt: new Date().toISOString(),
  version,
  label,
  buildMetadataPath,
  bundleDir,
  archivePath,
  checksumPath,
  files: bundleFiles.sort(),
};
await Deno.writeTextFile(
  join(outputDir, "bundle-metadata.json"),
  `${JSON.stringify(bundleMetadata, null, 2)}\n`,
);

console.log(`Packaged bundle into ${outputDir}`);
