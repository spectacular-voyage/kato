import { parseArgs } from "@std/cli";
import { dirname, fromFileUrl, isAbsolute, join, resolve } from "@std/path";

export interface BuildMetadata {
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

export interface BundleMetadata {
  createdAt: string;
  version: string;
  label: string;
  buildMetadataPath: string;
  bundleDir: string;
  archivePath: string;
  checksumPath: string;
  files: string[];
}

export interface AssembleNpmPackagesOptions {
  inputDirs: string[];
  outputDir: string;
  wrapperPackageName: string;
  platformPackagePrefix: string;
  commandName: string;
}

export interface NpmPackagesMetadata {
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

interface BundleInput {
  inputDir: string;
  bundleMetadata: BundleMetadata;
  buildMetadata: BuildMetadata;
  localBuildMetadataPath: string;
  localBundleDir: string;
}

interface PlatformPackageDefinition {
  packageName: string;
  packageSuffix: string;
  label: string;
  target: string;
  os: string;
  arch: string;
  cpu: string;
  libc?: string;
  executablePath: string;
  daemonExecutablePath: string;
  webExecutablePath: string;
}

const DEFAULT_WRAPPER_PACKAGE_NAME = "kato";
const DEFAULT_COMMAND_NAME = "kato";
const DEFAULT_PLATFORM_PACKAGE_PREFIX = "@spectacular-voyage/kato";
const REQUIRED_BINARY_BASENAMES = ["kato", "kato-daemon", "kato-web"] as const;

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function packagePublishConfig(
  packageName: string,
): { access: "public" } | undefined {
  return packageName.startsWith("@") ? { access: "public" } : undefined;
}

function packageRepositoryMetadata() {
  return {
    type: "git",
    url: "git+https://github.com/spectacular-voyage/kato.git",
  };
}

function binaryFileName(baseName: string, target: string): string {
  return target.includes("windows") ? `${baseName}.exe` : baseName;
}

async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as T;
}

function requireUnifiedAppVersion(buildMetadata: BuildMetadata): string {
  const versions = [
    buildMetadata.versions.cli,
    buildMetadata.versions.daemon,
    buildMetadata.versions.web,
  ];
  const unique = new Set(versions);
  if (unique.size !== 1) {
    throw new Error(
      `Build metadata version mismatch: cli=${buildMetadata.versions.cli}, daemon=${buildMetadata.versions.daemon}, web=${buildMetadata.versions.web}`,
    );
  }
  return versions[0];
}

function requireUnifiedReleaseVersion(inputs: BundleInput[]): string {
  const versions = inputs.map((input) => input.bundleMetadata.version);
  const unique = new Set(versions);
  if (unique.size !== 1) {
    throw new Error(
      `Bundle version mismatch across inputs: ${versions.join(", ")}`,
    );
  }
  return versions[0];
}

async function readBundleInput(inputDir: string): Promise<BundleInput> {
  const bundleMetadataPath = join(inputDir, "bundle-metadata.json");
  const bundleMetadata = await readJsonFile<BundleMetadata>(bundleMetadataPath);
  const localBundleDir = await resolveDownloadedPath(
    inputDir,
    bundleMetadata.bundleDir,
  );
  const localBuildMetadataPath = await resolveDownloadedPath(
    inputDir,
    bundleMetadata.buildMetadataPath,
    join(localBundleDir, "build-metadata.json"),
  );
  const buildMetadata = await readJsonFile<BuildMetadata>(
    localBuildMetadataPath,
  );
  const appVersion = requireUnifiedAppVersion(buildMetadata);
  if (bundleMetadata.version !== appVersion) {
    throw new Error(
      `Bundle version ${bundleMetadata.version} does not match build metadata version ${appVersion} for ${inputDir}`,
    );
  }

  for (const baseName of REQUIRED_BINARY_BASENAMES) {
    const binaryPath = join(
      localBundleDir,
      binaryFileName(baseName, buildMetadata.target),
    );
    const stat = await Deno.stat(binaryPath).catch((error) => {
      if (error instanceof Deno.errors.NotFound) {
        throw new Error(`Missing required bundle binary: ${binaryPath}`);
      }
      throw error;
    });
    if (!stat.isFile) {
      throw new Error(`Required bundle binary is not a file: ${binaryPath}`);
    }
  }

  return {
    inputDir,
    bundleMetadata,
    buildMetadata,
    localBuildMetadataPath,
    localBundleDir,
  };
}

async function ensureCleanDir(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  });
  await Deno.mkdir(path, { recursive: true });
}

async function copyFileWithMode(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dirname(dest), { recursive: true });
  await Deno.copyFile(src, dest);
  const stat = await Deno.stat(src);
  if (stat.mode !== null) {
    await Deno.chmod(dest, stat.mode).catch(() => {
      // chmod is best-effort and may be unsupported on some platforms.
    });
  }
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
      await Deno.stat(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
  throw new Error(
    `Could not resolve downloaded artifact path for ${preferredPath} under ${inputDir}`,
  );
}

function resolvePlatformPackageDefinition(
  input: BundleInput,
  platformPackagePrefix: string,
): PlatformPackageDefinition {
  const target = input.buildMetadata.target;
  switch (target) {
    case "linux-x86_64":
      return {
        packageName: `${platformPackagePrefix}-linux-x64-gnu`,
        packageSuffix: "linux-x64-gnu",
        label: input.bundleMetadata.label,
        target,
        os: "linux",
        arch: "x64",
        cpu: "x64",
        libc: "glibc",
        executablePath: "bin/kato",
        daemonExecutablePath: "bin/kato-daemon",
        webExecutablePath: "bin/kato-web",
      };
    case "windows-x86_64":
      return {
        packageName: `${platformPackagePrefix}-win32-x64`,
        packageSuffix: "win32-x64",
        label: input.bundleMetadata.label,
        target,
        os: "win32",
        arch: "x64",
        cpu: "x64",
        executablePath: "bin/kato.exe",
        daemonExecutablePath: "bin/kato-daemon.exe",
        webExecutablePath: "bin/kato-web.exe",
      };
    case "darwin-x86_64":
      return {
        packageName: `${platformPackagePrefix}-darwin-x64`,
        packageSuffix: "darwin-x64",
        label: input.bundleMetadata.label,
        target,
        os: "darwin",
        arch: "x64",
        cpu: "x64",
        executablePath: "bin/kato",
        daemonExecutablePath: "bin/kato-daemon",
        webExecutablePath: "bin/kato-web",
      };
    case "darwin-aarch64":
      return {
        packageName: `${platformPackagePrefix}-darwin-arm64`,
        packageSuffix: "darwin-arm64",
        label: input.bundleMetadata.label,
        target,
        os: "darwin",
        arch: "arm64",
        cpu: "arm64",
        executablePath: "bin/kato",
        daemonExecutablePath: "bin/kato-daemon",
        webExecutablePath: "bin/kato-web",
      };
    default:
      throw new Error(
        `Unsupported binary bundle target for npm packaging: ${target}`,
      );
  }
}

function makeWrapperReadme(
  wrapperPackageName: string,
  commandName: string,
): string {
  return [
    `# ${wrapperPackageName}`,
    "",
    "Generated npm wrapper package for Kato.",
    "",
    `This package installs the \`${commandName}\` command and launches the`,
    "platform-native Kato binary package selected by npm optional dependencies.",
    "",
    "This package is generated from the native binary release bundles and should",
    "not contain source-build or postinstall download logic.",
    "",
  ].join("\n");
}

function makePlatformReadme(
  packageName: string,
  label: string,
): string {
  return [
    `# ${packageName}`,
    "",
    `Generated native binary package for Kato on ${label}.`,
    "",
    "This package is intended to be installed via the top-level Kato npm wrapper",
    "package and contains the packaged native executables plus release metadata.",
    "",
  ].join("\n");
}

function makeWrapperLauncher(): string {
  return String.raw`#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");
const process = require("node:process");

const selfRequire = createRequire(__filename);
const packageMap = selfRequire("../package-map.json");

function detectLibc() {
  if (process.platform !== "linux") {
    return undefined;
  }
  if (process.report && typeof process.report.getReport === "function") {
    const report = process.report.getReport();
    const header = report && report.header ? report.header : undefined;
    if (header && header.glibcVersionRuntime) {
      return "glibc";
    }
    return "musl";
  }
  return undefined;
}

function selectPlatformPackage() {
  const libc = detectLibc();
  return packageMap.platforms.find((entry) => {
    if (entry.os !== process.platform || entry.arch !== process.arch) {
      return false;
    }
    if (entry.libc && entry.libc !== libc) {
      return false;
    }
    return true;
  });
}

const selected = selectPlatformPackage();
if (!selected) {
  const libc = detectLibc();
  const suffix = libc ? "/" + libc : "";
  console.error(
    "kato does not currently provide a native npm package for " +
      process.platform +
      "/" +
      process.arch +
      suffix,
  );
  process.exit(1);
}

let packageJsonPath;
try {
  packageJsonPath = selfRequire.resolve(selected.packageName + "/package.json");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    "kato could not resolve the installed native package " +
      selected.packageName +
      ": " +
      message,
  );
  process.exit(1);
}

const packageRoot = path.dirname(packageJsonPath);
const executablePath = path.join(packageRoot, selected.executablePath);
const child = spawn(executablePath, process.argv.slice(2), {
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("kato failed to launch the packaged binary: " + message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});
`;
}

function packageMapForDefinitions(definitions: PlatformPackageDefinition[]) {
  return {
    platforms: definitions.map((definition) => ({
      packageName: definition.packageName,
      os: definition.os,
      arch: definition.arch,
      ...(definition.libc ? { libc: definition.libc } : {}),
      executablePath: definition.executablePath,
    })),
  };
}

function makeWrapperPackageJson(
  wrapperPackageName: string,
  version: string,
  commandName: string,
  platformPackages: PlatformPackageDefinition[],
) {
  return {
    name: wrapperPackageName,
    version,
    description: "Kato npm wrapper that launches the packaged native binary",
    license: "Apache-2.0",
    repository: packageRepositoryMetadata(),
    homepage: "https://github.com/spectacular-voyage/kato",
    bin: { [commandName]: "bin/kato.cjs" },
    files: ["bin", "package-map.json", "README.md", "LICENSE"],
    optionalDependencies: Object.fromEntries(
      platformPackages
        .slice()
        .sort((left, right) =>
          left.packageName.localeCompare(right.packageName)
        )
        .map((definition) => [definition.packageName, version]),
    ),
    engines: { node: ">=18" },
    ...(packagePublishConfig(wrapperPackageName)
      ? { publishConfig: packagePublishConfig(wrapperPackageName) }
      : {}),
  };
}

function makePlatformPackageJson(
  packageName: string,
  version: string,
  definition: PlatformPackageDefinition,
) {
  return {
    name: packageName,
    version,
    description: `Native Kato binaries for ${definition.label}`,
    license: "Apache-2.0",
    repository: packageRepositoryMetadata(),
    homepage: "https://github.com/spectacular-voyage/kato",
    os: [definition.os],
    cpu: [definition.cpu],
    ...(definition.libc ? { libc: [definition.libc] } : {}),
    files: [
      "bin",
      "build-metadata.json",
      "bundle-metadata.json",
      "README.md",
      "LICENSE",
    ],
    ...(packagePublishConfig(packageName)
      ? { publishConfig: packagePublishConfig(packageName) }
      : {}),
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeExecutableTextFile(
  path: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755).catch(() => {
    // chmod is best-effort and may be unsupported on some platforms.
  });
}

export async function assembleNpmPackages(
  options: AssembleNpmPackagesOptions,
): Promise<NpmPackagesMetadata> {
  if (options.inputDirs.length === 0) {
    throw new Error("At least one --input-dir is required");
  }

  const inputs = await Promise.all(
    options.inputDirs.map((inputDir) => readBundleInput(inputDir)),
  );
  const version = requireUnifiedReleaseVersion(inputs);
  const definitions = inputs.map((input) =>
    resolvePlatformPackageDefinition(input, options.platformPackagePrefix)
  );

  await ensureCleanDir(options.outputDir);

  const wrapperDir = join(options.outputDir, "wrapper");
  await Deno.mkdir(join(wrapperDir, "bin"), { recursive: true });
  await copyFileWithMode(
    join(repoRoot(), "LICENSE"),
    join(wrapperDir, "LICENSE"),
  );
  await Deno.writeTextFile(
    join(wrapperDir, "README.md"),
    makeWrapperReadme(options.wrapperPackageName, options.commandName),
  );
  await writeJsonFile(
    join(wrapperDir, "package.json"),
    makeWrapperPackageJson(
      options.wrapperPackageName,
      version,
      options.commandName,
      definitions,
    ),
  );
  await writeJsonFile(
    join(wrapperDir, "package-map.json"),
    packageMapForDefinitions(definitions),
  );
  await writeExecutableTextFile(
    join(wrapperDir, "bin", "kato.cjs"),
    makeWrapperLauncher(),
  );

  const platformPackagesMetadata: NpmPackagesMetadata["platformPackages"] = [];
  for (const [index, input] of inputs.entries()) {
    const definition = definitions[index];
    const packageDir = join(
      options.outputDir,
      "platforms",
      definition.packageSuffix,
    );
    await Deno.mkdir(join(packageDir, "bin"), { recursive: true });
    await copyFileWithMode(
      join(repoRoot(), "LICENSE"),
      join(packageDir, "LICENSE"),
    );
    await Deno.writeTextFile(
      join(packageDir, "README.md"),
      makePlatformReadme(definition.packageName, definition.label),
    );
    await writeJsonFile(
      join(packageDir, "package.json"),
      makePlatformPackageJson(definition.packageName, version, definition),
    );
    await copyFileWithMode(
      input.localBuildMetadataPath,
      join(packageDir, "build-metadata.json"),
    );
    await copyFileWithMode(
      join(input.inputDir, "bundle-metadata.json"),
      join(packageDir, "bundle-metadata.json"),
    );

    for (const baseName of REQUIRED_BINARY_BASENAMES) {
      const fileName = binaryFileName(baseName, definition.target);
      await copyFileWithMode(
        join(input.localBundleDir, fileName),
        join(packageDir, "bin", fileName),
      );
    }

    platformPackagesMetadata.push({
      packageName: definition.packageName,
      label: definition.label,
      target: definition.target,
      packageDir,
      os: definition.os,
      cpu: definition.cpu,
      ...(definition.libc ? { libc: definition.libc } : {}),
      executablePath: definition.executablePath,
    });
  }

  const metadata: NpmPackagesMetadata = {
    createdAt: new Date().toISOString(),
    version,
    wrapperPackageName: options.wrapperPackageName,
    platformPackagePrefix: options.platformPackagePrefix,
    commandName: options.commandName,
    wrapperDir,
    platformPackages: platformPackagesMetadata,
  };
  await writeJsonFile(
    join(options.outputDir, "npm-packages-metadata.json"),
    metadata,
  );
  return metadata;
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/assemble-npm-packages.ts --input-dir <path> [options]",
      "",
      "Options:",
      "  --input-dir <path>              Bundle output directory produced by scripts/package-binaries.ts",
      "                                 Repeat the flag to include multiple platforms.",
      "  --output-dir <path>             Output directory (default: .test-tmp/npm-packages)",
      `  --wrapper-package-name <name>   Wrapper package name (default: ${DEFAULT_WRAPPER_PACKAGE_NAME})`,
      `  --platform-package-prefix <p>   Platform package prefix (default: ${DEFAULT_PLATFORM_PACKAGE_PREFIX})`,
      `  --command-name <name>           Public CLI command name (default: ${DEFAULT_COMMAND_NAME})`,
      "  --help                          Show this help",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const parsed = parseArgs(rawArgs, {
    string: [
      "input-dir",
      "output-dir",
      "wrapper-package-name",
      "platform-package-prefix",
      "command-name",
    ],
    boolean: ["help"],
    collect: ["input-dir"],
    default: {
      help: false,
      "wrapper-package-name": DEFAULT_WRAPPER_PACKAGE_NAME,
      "platform-package-prefix": DEFAULT_PLATFORM_PACKAGE_PREFIX,
      "command-name": DEFAULT_COMMAND_NAME,
    },
  });

  if (parsed.help) {
    printUsage();
    Deno.exit(0);
  }

  const root = repoRoot();
  const inputValues = Array.isArray(parsed["input-dir"])
    ? parsed["input-dir"]
    : parsed["input-dir"]
    ? [parsed["input-dir"]]
    : [];
  const inputDirs = inputValues.map((value) => resolvePath(root, value));
  const wrapperPackageName = parsed["wrapper-package-name"];
  const platformPackagePrefix = parsed["platform-package-prefix"];
  const commandName = parsed["command-name"];
  const outputDir = parsed["output-dir"]
    ? resolvePath(root, parsed["output-dir"])
    : join(root, ".test-tmp", "npm-packages");

  if (!wrapperPackageName || !commandName) {
    throw new Error("wrapper package name and command name are required");
  }

  const metadata = await assembleNpmPackages({
    inputDirs,
    outputDir,
    wrapperPackageName,
    platformPackagePrefix,
    commandName,
  });
  console.log(`Assembled npm packages into ${metadata.wrapperDir}`);
}
