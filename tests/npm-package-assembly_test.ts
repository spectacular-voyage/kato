import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { assembleNpmPackages } from "../scripts/assemble-npm-packages.ts";

function uniquePath(label: string): string {
  return join(
    Deno.cwd(),
    ".test-tmp",
    "npm-package-assembly",
    `${label}-${crypto.randomUUID()}`,
  );
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  await Deno.chmod(path, 0o755).catch(() => {});
}

async function createBundleInput(
  root: string,
  label: string,
  target: string,
  version: string,
  options: {
    staleAbsolutePaths?: boolean;
    sourceBinaryMode?: number;
  } = {},
): Promise<string> {
  const inputDir = join(root, label);
  const bundleDir = join(inputDir, `kato-v${version}-${label}`);
  await Deno.mkdir(bundleDir, { recursive: true });

  const binaryNames = target.includes("windows")
    ? ["kato.exe", "kato-daemon.exe", "kato-web.exe"]
    : ["kato", "kato-daemon", "kato-web"];
  for (const fileName of binaryNames) {
    await writeExecutable(join(bundleDir, fileName), `echo ${fileName}\n`);
    if (options.sourceBinaryMode !== undefined) {
      await Deno.chmod(join(bundleDir, fileName), options.sourceBinaryMode)
        .catch(() => {});
    }
  }
  await Deno.writeTextFile(join(bundleDir, "README.md"), "# Bundle\n");
  await Deno.writeTextFile(join(bundleDir, "LICENSE"), "Apache-2.0\n");

  const buildMetadataPath = join(bundleDir, "build-metadata.json");
  await Deno.writeTextFile(
    buildMetadataPath,
    `${
      JSON.stringify(
        {
          builtAt: "2026-03-12T00:00:00.000Z",
          target,
          outputDir: "/tmp/out",
          binaries: binaryNames.map((fileName) => ({
            name: fileName.replace(/\.exe$/, ""),
            outputPath: join(bundleDir, fileName),
            entrypoint: "entry.ts",
            permissions: [],
            extraArgs: [],
          })),
          versions: {
            cli: version,
            daemon: version,
            web: version,
          },
        },
        null,
        2,
      )
    }\n`,
  );

  await Deno.writeTextFile(
    join(inputDir, "bundle-metadata.json"),
    `${
      JSON.stringify(
        {
          createdAt: "2026-03-12T00:00:00.000Z",
          version,
          label,
          buildMetadataPath: options.staleAbsolutePaths
            ? `/stale/source/${label}/build-metadata.json`
            : buildMetadataPath,
          bundleDir: options.staleAbsolutePaths
            ? `/stale/source/${label}/kato-v${version}-${label}`
            : bundleDir,
          archivePath: join(inputDir, `kato-v${version}-${label}.tar.gz`),
          checksumPath: join(
            inputDir,
            `kato-v${version}-${label}.tar.gz.sha256`,
          ),
          files: [
            "LICENSE",
            "README.md",
            "build-metadata.json",
            ...binaryNames,
          ],
        },
        null,
        2,
      )
    }\n`,
  );

  return inputDir;
}

Deno.test("assembleNpmPackages creates wrapper and platform package directories", async () => {
  const root = uniquePath("single");
  const inputDir = await createBundleInput(
    root,
    "linux-x64",
    "linux-x86_64",
    "0.2.4",
  );
  const outputDir = join(root, "output");

  const metadata = await assembleNpmPackages({
    inputDirs: [inputDir],
    outputDir,
    wrapperPackageName: "@spectacular-voyage/kato",
    platformPackagePrefix: "@spectacular-voyage/kato",
    commandName: "kato",
  });

  assertEquals(metadata.version, "0.2.4");
  assertEquals(metadata.wrapperPackageName, "@spectacular-voyage/kato");
  assertEquals(metadata.platformPackages.length, 1);
  assertEquals(
    metadata.platformPackages[0].packageName,
    "@spectacular-voyage/kato-linux-x64-gnu",
  );

  const wrapperPackageJson = JSON.parse(
    await Deno.readTextFile(join(outputDir, "wrapper", "package.json")),
  ) as Record<string, unknown>;
  assertEquals(wrapperPackageJson["name"], "@spectacular-voyage/kato");
  assertEquals(
    (wrapperPackageJson["bin"] as Record<string, string>)["kato"],
    "bin/kato.cjs",
  );
  assertEquals(
    (wrapperPackageJson["optionalDependencies"] as Record<string, string>)[
      "@spectacular-voyage/kato-linux-x64-gnu"
    ],
    "0.2.4",
  );

  const platformPackageJson = JSON.parse(
    await Deno.readTextFile(
      join(outputDir, "platforms", "linux-x64-gnu", "package.json"),
    ),
  ) as Record<string, unknown>;
  assertEquals(
    platformPackageJson["name"],
    "@spectacular-voyage/kato-linux-x64-gnu",
  );
  assertEquals(platformPackageJson["os"], ["linux"]);
  assertEquals(platformPackageJson["cpu"], ["x64"]);
  assertEquals(platformPackageJson["libc"], ["glibc"]);

  const wrapperLauncher = await Deno.readTextFile(
    join(outputDir, "wrapper", "bin", "kato.cjs"),
  );
  assert(wrapperLauncher.includes("package-map.json"));

  for (const fileName of ["kato", "kato-daemon", "kato-web"]) {
    const stat = await Deno.stat(
      join(outputDir, "platforms", "linux-x64-gnu", "bin", fileName),
    );
    assert(stat.isFile);
  }
});

Deno.test("assembleNpmPackages rejects mismatched bundle versions", async () => {
  const root = uniquePath("mismatch");
  const linuxDir = await createBundleInput(
    root,
    "linux-x64",
    "linux-x86_64",
    "0.2.4",
  );
  const macDir = await createBundleInput(
    root,
    "macos-x64",
    "darwin-x86_64",
    "0.2.5",
  );
  const outputDir = join(root, "output");

  await assertRejects(
    () =>
      assembleNpmPackages({
        inputDirs: [linuxDir, macDir],
        outputDir,
        wrapperPackageName: "@spectacular-voyage/kato",
        platformPackagePrefix: "@spectacular-voyage/kato",
        commandName: "kato",
      }),
    Error,
    "Bundle version mismatch across inputs",
  );
});

Deno.test("assembleNpmPackages resolves downloaded artifact paths from stale bundle metadata", async () => {
  const root = uniquePath("downloaded");
  const inputDir = await createBundleInput(
    root,
    "linux-x64",
    "linux-x86_64",
    "0.2.4",
    { staleAbsolutePaths: true },
  );
  const outputDir = join(root, "output");

  const metadata = await assembleNpmPackages({
    inputDirs: [inputDir],
    outputDir,
    wrapperPackageName: "@spectacular-voyage/kato",
    platformPackagePrefix: "@spectacular-voyage/kato",
    commandName: "kato",
  });

  assertEquals(metadata.platformPackages.length, 1);
  const stat = await Deno.stat(
    join(outputDir, "platforms", "linux-x64-gnu", "bin", "kato"),
  );
  assert(stat.isFile);
});

Deno.test("assembleNpmPackages restores executable mode for unix platform binaries", async () => {
  if (Deno.build.os === "windows") {
    return;
  }

  const root = uniquePath("unix-mode");
  const inputDir = await createBundleInput(
    root,
    "linux-x64",
    "linux-x86_64",
    "0.2.4",
    { sourceBinaryMode: 0o644 },
  );
  const outputDir = join(root, "output");

  await assembleNpmPackages({
    inputDirs: [inputDir],
    outputDir,
    wrapperPackageName: "@spectacular-voyage/kato",
    platformPackagePrefix: "@spectacular-voyage/kato",
    commandName: "kato",
  });

  const stat = await Deno.stat(
    join(outputDir, "platforms", "linux-x64-gnu", "bin", "kato"),
  );
  assert(stat.isFile);
  if (stat.mode !== null) {
    assertEquals(stat.mode & 0o111, 0o111);
  }
});
