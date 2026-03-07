import { assert, assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import type { RecordingPipelineLike } from "../apps/daemon/src/writer/mod.ts";
import {
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  type ResolvedWorkspaceProfile,
} from "../apps/daemon/src/workspace/mod.ts";
import {
  normalizeRawCommandTargetPath,
  resolveUniqueNonExistingPath,
  resolveWorkspaceCommandDestination,
  validateDestinationPathForCommand,
} from "../apps/daemon/src/orchestrator/runtime_command_destination.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeProfile(workspaceRoot: string): ResolvedWorkspaceProfile {
  return {
    workspaceId: "workspace-1",
    alias: "my-proj",
    workspaceRoot,
    configPath: join(workspaceRoot, ".kato-workspace.yaml"),
    resolvedDefaultOutputDir: join(workspaceRoot, "notes"),
    defaultOutputDirTemplate: "notes",
    filenameTemplate: "capture.md",
    workspaceTimezone: "UTC",
    markdownFrontmatter: createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags(),
  };
}

Deno.test("normalizeRawCommandTargetPath trims markdown links and delimiters", () => {
  assertEquals(normalizeRawCommandTargetPath(undefined), undefined);
  assertEquals(normalizeRawCommandTargetPath("   "), undefined);
  assertEquals(normalizeRawCommandTargetPath("`notes/a.md`"), "notes/a.md");
  assertEquals(
    normalizeRawCommandTargetPath('[x]("notes/quoted.md")'),
    "notes/quoted.md",
  );
});

Deno.test("resolveWorkspaceCommandDestination resolves default, relative, and absolute bindings", async () => {
  await withTestTempDir("daemon-command-destination-", async (dir) => {
    const workspaceRoot = resolve(dir, "workspace");
    await Deno.mkdir(join(workspaceRoot, "notes"), { recursive: true });
    const profile = makeProfile(workspaceRoot);
    const now = new Date("2026-03-07T10:00:00.000Z");

    const defaultDestination = await resolveWorkspaceCommandDestination({
      profile,
      provider: "codex",
      sessionId: "session-default",
      outputUsername: "user-1",
      now,
    });
    assertEquals(
      defaultDestination.resolvedPath,
      join(workspaceRoot, "notes", "capture.md"),
    );
    assertEquals(defaultDestination.usesGeneratedFilename, true);
    assertEquals(defaultDestination.binding.kind, "workspace-relative");
    if (defaultDestination.binding.kind !== "workspace-relative") {
      throw new Error("expected workspace-relative binding");
    }
    assertEquals(
      defaultDestination.binding.relativePathFromWorkspaceRoot,
      join("notes", "capture.md"),
    );

    const relativeDestination = await resolveWorkspaceCommandDestination({
      profile,
      provider: "codex",
      sessionId: "session-relative",
      outputUsername: "user-1",
      rawArgument: "notes/relative.md",
      now,
    });
    assertEquals(
      relativeDestination.resolvedPath,
      join(workspaceRoot, "notes", "relative.md"),
    );
    assertEquals(relativeDestination.usesGeneratedFilename, false);
    assertEquals(relativeDestination.binding.kind, "workspace-relative");
    if (relativeDestination.binding.kind !== "workspace-relative") {
      throw new Error("expected workspace-relative binding");
    }
    assertEquals(
      relativeDestination.binding.relativePathFromWorkspaceRoot,
      join("notes", "relative.md"),
    );

    const absolutePath = resolve(workspaceRoot, "..", "absolute.md");
    const absoluteDestination = await resolveWorkspaceCommandDestination({
      profile,
      provider: "codex",
      sessionId: "session-absolute",
      outputUsername: "user-1",
      rawArgument: absolutePath,
      now,
    });
    assertEquals(absoluteDestination.resolvedPath, absolutePath);
    assertEquals(absoluteDestination.binding.kind, "absolute-explicit");
    if (absoluteDestination.binding.kind !== "absolute-explicit") {
      throw new Error("expected absolute-explicit binding");
    }
    assertEquals(absoluteDestination.binding.absolutePath, absolutePath);
  });
});

Deno.test("resolveWorkspaceCommandDestination rejects mention-style arguments", async () => {
  await withTestTempDir("daemon-command-destination-mention-", async (dir) => {
    const profile = makeProfile(resolve(dir, "workspace"));
    await assertRejects(
      () =>
        resolveWorkspaceCommandDestination({
          profile,
          provider: "codex",
          sessionId: "session-mention",
          outputUsername: "user-1",
          rawArgument: "@my-workspace",
          now: new Date("2026-03-07T10:00:00.000Z"),
        }),
      Error,
      "Path argument must be a filesystem path",
    );
  });
});

Deno.test("resolveWorkspaceCommandDestination applies unique suffixes for generated directory targets", async () => {
  await withTestTempDir("daemon-command-destination-unique-", async (dir) => {
    const workspaceRoot = resolve(dir, "workspace");
    const targetDir = join(workspaceRoot, "notes");
    await Deno.mkdir(targetDir, { recursive: true });
    await Deno.writeTextFile(join(targetDir, "capture.md"), "first");
    await Deno.writeTextFile(join(targetDir, "capture-2.md"), "second");
    const profile = makeProfile(workspaceRoot);

    const destination = await resolveWorkspaceCommandDestination({
      profile,
      provider: "codex",
      sessionId: "session-unique",
      outputUsername: "user-1",
      rawArgument: "notes/",
      ensureGeneratedPathUnique: true,
      now: new Date("2026-03-07T10:00:00.000Z"),
    });
    assertEquals(destination.usesGeneratedFilename, true);
    assertEquals(destination.resolvedPath, join(targetDir, "capture-3.md"));
  });
});

Deno.test("resolveUniqueNonExistingPath adds numeric suffixes after collisions", async () => {
  await withTestTempDir("daemon-command-destination-suffix-", async (dir) => {
    const target = join(dir, "export.md");
    await Deno.writeTextFile(target, "first");
    await Deno.writeTextFile(join(dir, "export-2.md"), "second");

    const resolved = await resolveUniqueNonExistingPath(target);
    assertEquals(resolved, join(dir, "export-3.md"));
  });
});

Deno.test("validateDestinationPathForCommand supports passthrough and policy hooks", async () => {
  const passthroughPipeline = {
    activateRecording() {
      throw new Error("not used");
    },
    captureSnapshot() {
      throw new Error("not used");
    },
    exportSnapshot() {
      throw new Error("not used");
    },
    appendToActiveRecording() {
      throw new Error("not used");
    },
    stopRecording() {
      throw new Error("not used");
    },
    getActiveRecording() {
      return undefined;
    },
    listActiveRecordings() {
      return [];
    },
    getRecordingSummary() {
      return { activeRecordings: 0, destinations: 0 };
    },
  } as unknown as RecordingPipelineLike;
  assertEquals(
    await validateDestinationPathForCommand(
      passthroughPipeline,
      "codex",
      "session-1",
      "/tmp/a.md",
      "record",
    ),
    "/tmp/a.md",
  );

  let validateCall:
    | {
      provider: string;
      sessionId: string;
      targetPath: string;
      commandName?: "record" | "capture" | "export";
    }
    | undefined;
  const validatingPipeline = {
    ...passthroughPipeline,
    validateDestinationPath(input) {
      validateCall = {
        provider: input.provider,
        sessionId: input.sessionId,
        targetPath: input.targetPath,
        commandName: input.commandName,
      };
      return Promise.resolve(`${input.targetPath}.validated`);
    },
  } as RecordingPipelineLike;

  const validated = await validateDestinationPathForCommand(
    validatingPipeline,
    "codex",
    "session-2",
    "/tmp/b.md",
    "capture",
  );
  assertEquals(validated, "/tmp/b.md.validated");
  assert(validateCall !== undefined);
  assertEquals(validateCall?.provider, "codex");
  assertEquals(validateCall?.sessionId, "session-2");
  assertEquals(validateCall?.targetPath, "/tmp/b.md");
  assertEquals(validateCall?.commandName, "capture");
});
