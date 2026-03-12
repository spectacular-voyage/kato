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

interface HostPlatformPackage {
  packageName: string;
  label: string;
  target: string;
  packageDir: string;
  os: string;
  cpu: string;
  libc?: string;
  executablePath: string;
}

function repoRoot(): string {
  return dirname(dirname(fromFileUrl(import.meta.url)));
}

function resolvePath(root: string, value: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function pathListSeparator(os: string = Deno.build.os): string {
  return os === "windows" ? ";" : ":";
}

async function readMetadata(path: string): Promise<NpmPackagesMetadata> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as NpmPackagesMetadata;
}

export function currentNodeArch(): string {
  switch (Deno.build.arch) {
    case "x86_64":
      return "x64";
    case "aarch64":
      return "arm64";
    default:
      return Deno.build.arch;
  }
}

function currentNodePlatform(): string {
  return Deno.build.os === "windows" ? "win32" : Deno.build.os;
}

async function detectCurrentLibc(): Promise<"glibc" | "musl" | undefined> {
  if (Deno.build.os !== "linux") {
    return undefined;
  }

  const child = new Deno.Command("sh", {
    args: [
      "-lc",
      "if command -v ldd >/dev/null 2>&1; then ldd --version 2>&1 || true; fi",
    ],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const result = await child.output();
  const combined = `${new TextDecoder().decode(result.stdout)}\n${
    new TextDecoder().decode(result.stderr)
  }`.toLowerCase();
  if (combined.includes("musl")) {
    return "musl";
  }
  return "glibc";
}

function findHostPlatformPackage(
  metadata: NpmPackagesMetadata,
  libc: string | undefined,
): HostPlatformPackage | undefined {
  const os = currentNodePlatform();
  const cpu = currentNodeArch();
  return metadata.platformPackages.find((entry) => {
    if (entry.os !== os || entry.cpu !== cpu) {
      return false;
    }
    if (entry.libc !== undefined && entry.libc !== libc) {
      return false;
    }
    return true;
  });
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

export async function resolveSmokePackagePaths(
  metadata: NpmPackagesMetadata,
  inputDir: string,
  libc: string | undefined,
): Promise<{ wrapperDir: string; platformPackage: HostPlatformPackage }> {
  const platformPackage = findHostPlatformPackage(metadata, libc);
  if (!platformPackage) {
    throw new Error(
      `No platform package found for host ${Deno.build.os}/${currentNodeArch()}${
        libc ? `/${libc}` : ""
      }`,
    );
  }

  const wrapperDir = await resolveDownloadedPath(
    inputDir,
    metadata.wrapperDir,
    join(inputDir, "wrapper"),
  );
  const resolvedPlatformDir = await resolveDownloadedPath(
    inputDir,
    platformPackage.packageDir,
    join(
      inputDir,
      "platforms",
      platformPackage.packageDir.split(/[\\/]/).at(-1) ?? platformPackage.label,
    ),
  );
  return {
    wrapperDir,
    platformPackage: {
      ...platformPackage,
      packageDir: resolvedPlatformDir,
    },
  };
}

export function localProjectCommandPath(
  projectDir: string,
  commandName: string,
  os: string = Deno.build.os,
): string {
  return join(
    projectDir,
    "node_modules",
    ".bin",
    os === "windows" ? `${commandName}.cmd` : commandName,
  );
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
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

async function npmPack(
  npmBin: string,
  packageDir: string,
  baseEnv: Record<string, string>,
): Promise<string> {
  const child = new Deno.Command(npmBin, {
    args: ["pack", "--json"],
    cwd: packageDir,
    env: {
      ...baseEnv,
      PATH: `${dirname(npmBin)}${
        baseEnv.PATH ? `${pathListSeparator()}${baseEnv.PATH}` : ""
      }`,
    },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const result = await child.output();
  if (result.code !== 0) {
    throw new Error(`npm pack failed in ${packageDir}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as Array<{
    filename: string;
  }>;
  const filename = parsed[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a filename for ${packageDir}`);
  }
  return join(packageDir, filename);
}

function allocatePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function printUsage(): void {
  console.log(
    [
      "Usage: deno run -A scripts/smoke-npm-install.ts [options]",
      "",
      "Options:",
      "  --input-dir <path>    npm package assembly output dir (default: .test-tmp/npm-packages/package-smoke)",
      "  --npm-bin <path>      npm executable to use (default: npm)",
      "  --help                Show this help",
    ].join("\n"),
  );
}

if (import.meta.main) {
  const rawArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
  const parsed = parseArgs(rawArgs, {
    string: ["input-dir", "npm-bin"],
    boolean: ["help"],
    default: {
      help: false,
      "npm-bin": "npm",
    },
  });

  if (parsed.help) {
    printUsage();
    Deno.exit(0);
  }

  const root = repoRoot();
  const inputDir = parsed["input-dir"]
    ? resolvePath(root, parsed["input-dir"])
    : join(root, ".test-tmp", "npm-packages", "package-smoke");
  const npmBin = parsed["npm-bin"];
  if (!npmBin) {
    throw new Error("--npm-bin is required");
  }

  const metadata = await readMetadata(
    join(inputDir, "npm-packages-metadata.json"),
  );
  const libc = await detectCurrentLibc();
  const { wrapperDir, platformPackage } = await resolveSmokePackagePaths(
    metadata,
    inputDir,
    libc,
  );

  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    if (value !== undefined) {
      baseEnv[key] = value;
    }
  }
  baseEnv.PATH = `${dirname(npmBin)}${
    baseEnv.PATH ? `${pathListSeparator()}${baseEnv.PATH}` : ""
  }`;

  const wrapperTarball = await npmPack(npmBin, wrapperDir, baseEnv);
  const platformTarball = await npmPack(
    npmBin,
    platformPackage.packageDir,
    baseEnv,
  );

  const smokeRoot = join(root, ".test-tmp", "npm-install-smoke");
  const projectDir = join(smokeRoot, "project");
  const homeDir = join(smokeRoot, "home");
  await Deno.remove(smokeRoot, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  });
  await Deno.mkdir(projectDir, { recursive: true });
  await Deno.mkdir(homeDir, { recursive: true });
  await Deno.writeTextFile(
    join(projectDir, "package.json"),
    `${JSON.stringify({ name: "kato-npm-install-smoke", private: true })}\n`,
  );

  await runCommand(
    npmBin,
    ["install", "--no-package-lock", wrapperTarball, platformTarball],
    projectDir,
    baseEnv,
  );

  await runCommand(
    localProjectCommandPath(projectDir, metadata.commandName),
    ["--version"],
    projectDir,
    baseEnv,
  );

  const port = allocatePort();
  const smokeEnv = {
    ...baseEnv,
    HOME: homeDir,
    USERPROFILE: homeDir,
    KATO_WEB_PASSWORD: "smoke-pass",
  };
  const katoBin = localProjectCommandPath(projectDir, metadata.commandName);

  await runCommand(katoBin, ["init"], projectDir, smokeEnv);
  await runCommand(
    katoBin,
    [
      "web",
      "init",
      "--username",
      "smoke",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    projectDir,
    smokeEnv,
  );
  await runCommand(katoBin, ["web", "start"], projectDir, smokeEnv);

  let loginOk = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`);
      if (response.ok) {
        loginOk = true;
        break;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!loginOk) {
    throw new Error(
      `Timed out waiting for npm-installed kato-web at port ${port}`,
    );
  }

  await runCommand(katoBin, ["web", "status"], projectDir, smokeEnv);
  await runCommand(katoBin, ["web", "stop"], projectDir, smokeEnv);
  console.log(
    `npm install smoke passed for ${metadata.wrapperPackageName} + ${platformPackage.packageName}`,
  );
}
