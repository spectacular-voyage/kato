import { assertEquals, assertExists } from "@std/assert";
import { resolve } from "@std/path";
import type { SessionMetadataV1 } from "@kato/shared";
import {
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  type ResolvedWorkspaceProfile,
} from "../apps/daemon/src/workspace/mod.ts";
import {
  activeWorkspaceOutputs,
  applyWorkspaceProfileSnapshot,
  closeWorkspaceOutputCycle,
  createWorkspaceOutputState,
  findWorkspaceOutput,
  openWorkspaceOutputCycle,
  readWorkspaceOutputs,
  resolveBindingForRetargetedWorkspacePath,
  stopAllWorkspaceOutputs,
  toWorkspaceDestinationBinding,
  updateWorkspaceOutputCycleLastWrite,
  type WorkspaceOutputState,
} from "../apps/daemon/src/orchestrator/runtime_workspace_output_state.ts";

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function makeProfile(
  overrides: Partial<ResolvedWorkspaceProfile> = {},
): ResolvedWorkspaceProfile {
  const workspaceRoot = overrides.workspaceRoot ??
    resolve(".test-tmp", "workspace-output-state");
  const alias = overrides.alias ?? "alpha";
  return {
    workspaceId: overrides.workspaceId ?? `ws-${alias}`,
    alias,
    workspaceRoot,
    configPath: overrides.configPath ??
      resolve(workspaceRoot, ".kato", "workspace.yaml"),
    resolvedDefaultOutputDir: overrides.resolvedDefaultOutputDir ??
      resolve(workspaceRoot, "notes"),
    defaultOutputDirTemplate: overrides.defaultOutputDirTemplate ?? "notes",
    filenameTemplate: overrides.filenameTemplate ??
      "{provider}-{sessionShortId}.md",
    workspaceTimezone: overrides.workspaceTimezone ?? "local",
    defaultTags: overrides.defaultTags ?? [],
    tagSuggestions: overrides.tagSuggestions ?? [],
    markdownFrontmatter: overrides.markdownFrontmatter ??
      createDefaultWorkspaceMarkdownFrontmatterConfig(),
    writerFeatureFlags: overrides.writerFeatureFlags ??
      createDefaultWorkspaceWriterFeatureFlags(),
  };
}

function makeMetadata(
  overrides: Partial<SessionMetadataV1> = {},
): SessionMetadataV1 {
  return {
    schemaVersion: 1,
    sessionKey: "codex\u0000session-1",
    provider: "codex",
    providerSessionId: "session-1",
    sessionId: "kato-session-1",
    createdAt: "2026-02-22T10:00:00.000Z",
    updatedAt: "2026-02-22T10:00:00.000Z",
    sourceFilePath: resolve(".test-tmp", "session-1.jsonl"),
    ingestCursor: { kind: "byte-offset", value: 0 },
    twinPath: resolve(".test-tmp", "session-1.twin.jsonl"),
    nextTwinSeq: 1,
    recentFingerprints: [],
    ...overrides,
  };
}

function makeOutputState(
  profile: ResolvedWorkspaceProfile,
  overrides: {
    currentResolvedPath?: string;
    desiredState?: "on" | "off";
    writeCursor?: number;
    activeRecordingCycleId?: string;
    recordingCycles?: WorkspaceOutputState["recordingCycles"];
    currentDestination?: WorkspaceOutputState["currentDestination"];
  } = {},
): WorkspaceOutputState {
  const currentResolvedPath = overrides.currentResolvedPath ??
    resolve(profile.resolvedDefaultOutputDir, "output.md");
  const output = createWorkspaceOutputState({
    profile,
    binding: overrides.currentDestination ??
      toWorkspaceDestinationBinding(profile, currentResolvedPath),
    resolvedPath: currentResolvedPath,
    resolvedDefaultOutputDir: profile.resolvedDefaultOutputDir,
    desiredState: overrides.desiredState ?? "off",
    writeCursor: overrides.writeCursor ?? 0,
    nowIso: "2026-02-22T10:00:00.000Z",
  });
  output.recordingCycles = (overrides.recordingCycles ?? []).map((cycle) => ({
    ...cycle,
  }));
  if (overrides.activeRecordingCycleId) {
    output.activeRecordingCycleId = overrides.activeRecordingCycleId;
  }
  return output;
}

Deno.test(
  "readWorkspaceOutputs initializes metadata and activeWorkspaceOutputs filters on outputs",
  () => {
    const alpha = makeProfile({ alias: "alpha" });
    const beta = makeProfile({
      alias: "beta",
      workspaceRoot: resolve(".test-tmp", "workspace-output-state-beta"),
    });
    const metadata = makeMetadata();

    const outputs = readWorkspaceOutputs(metadata);
    assertEquals(outputs, []);
    assertExists(metadata.workspaceOutputs);

    outputs.push(makeOutputState(alpha, { desiredState: "on" }));
    outputs.push(makeOutputState(beta, { desiredState: "off" }));

    assertEquals(
      findWorkspaceOutput(metadata, alpha.workspaceId)?.workspaceId,
      alpha.workspaceId,
    );
    assertEquals(
      activeWorkspaceOutputs(metadata).map((output) => output.workspaceId),
      [alpha.workspaceId],
    );
  },
);

Deno.test(
  "findWorkspaceOutput prefers the latest active output for a workspace and otherwise returns the latest historical output",
  () => {
    const alpha = makeProfile({ alias: "alpha" });
    const metadata = makeMetadata();
    const outputs = readWorkspaceOutputs(metadata);

    outputs.push(makeOutputState(alpha, {
      currentResolvedPath: resolve(alpha.workspaceRoot, "notes", "older.md"),
      desiredState: "off",
    }));
    outputs.push(makeOutputState(alpha, {
      currentResolvedPath: resolve(alpha.workspaceRoot, "notes", "active.md"),
      desiredState: "on",
      activeRecordingCycleId: "cycle-active",
      recordingCycles: [{
        recordingCycleId: "cycle-active",
        startedCursor: 3,
        startedAt: "2026-02-22T10:03:00.000Z",
        startedBySeq: 3,
      }],
    }));
    outputs.push(makeOutputState(alpha, {
      currentResolvedPath: resolve(
        alpha.workspaceRoot,
        "notes",
        "newest-off.md",
      ),
      desiredState: "off",
    }));

    assertEquals(
      findWorkspaceOutput(metadata, alpha.workspaceId)?.currentResolvedPath,
      resolve(alpha.workspaceRoot, "notes", "active.md"),
    );

    closeWorkspaceOutputCycle(outputs[1]!, 5, "2026-02-22T10:05:00.000Z");

    assertEquals(
      findWorkspaceOutput(metadata, alpha.workspaceId)?.currentResolvedPath,
      resolve(alpha.workspaceRoot, "notes", "newest-off.md"),
    );
  },
);

Deno.test(
  "workspace destination binding keeps workspace-relative paths and preserves explicit absolute retargets",
  () => {
    const profile = makeProfile();

    const insideBinding = toWorkspaceDestinationBinding(
      profile,
      resolve(profile.workspaceRoot, "notes", "nested", "output.md"),
    );
    assertEquals(insideBinding.kind, "workspace-relative");
    if (insideBinding.kind === "workspace-relative") {
      assertExists(insideBinding.relativePathFromWorkspaceRoot);
      assertEquals(
        toPosixPath(insideBinding.relativePathFromWorkspaceRoot),
        "notes/nested/output.md",
      );
    }

    const rootBinding = toWorkspaceDestinationBinding(
      profile,
      profile.workspaceRoot,
    );
    assertEquals(rootBinding, {
      kind: "workspace-relative",
      relativePathFromWorkspaceRoot: ".",
    });

    const outsidePath = resolve(profile.workspaceRoot, "..", "outside.md");
    assertEquals(
      toWorkspaceDestinationBinding(profile, outsidePath),
      {
        kind: "absolute-explicit",
        absolutePath: outsidePath,
      },
    );

    const absoluteRetarget = resolveBindingForRetargetedWorkspacePath({
      profile,
      currentBinding: {
        kind: "absolute-explicit",
        absolutePath: resolve(profile.workspaceRoot, "old.md"),
      },
      resolvedPath: resolve(profile.workspaceRoot, "notes", "new.md"),
    });
    assertEquals(absoluteRetarget, {
      kind: "absolute-explicit",
      absolutePath: resolve(profile.workspaceRoot, "notes", "new.md"),
    });

    const relativeRetarget = resolveBindingForRetargetedWorkspacePath({
      profile,
      currentBinding: {
        kind: "workspace-relative",
        relativePathFromWorkspaceRoot: "notes/old.md",
      },
      resolvedPath: resolve(profile.workspaceRoot, "notes", "new.md"),
    });
    assertEquals(relativeRetarget.kind, "workspace-relative");
    if (relativeRetarget.kind === "workspace-relative") {
      assertExists(relativeRetarget.relativePathFromWorkspaceRoot);
      assertEquals(
        toPosixPath(relativeRetarget.relativePathFromWorkspaceRoot),
        "notes/new.md",
      );
    }
  },
);

Deno.test(
  "createWorkspaceOutputState and applyWorkspaceProfileSnapshot capture workspace metadata",
  () => {
    const initialProfile = makeProfile({
      alias: "alpha",
      defaultTags: ["initial"],
    });
    const output = createWorkspaceOutputState({
      profile: initialProfile,
      binding: {
        kind: "workspace-relative",
        relativePathFromWorkspaceRoot: "notes/output.md",
      },
      resolvedPath: resolve(initialProfile.workspaceRoot, "notes", "output.md"),
      resolvedDefaultOutputDir: initialProfile.resolvedDefaultOutputDir,
      desiredState: "off",
      writeCursor: 4,
      nowIso: "2026-02-22T10:00:00.000Z",
    });

    assertEquals(output.workspaceAliasSnapshot, "alpha");
    assertEquals(output.defaultTags, ["initial"]);
    assertEquals(output.recordingCycles, []);
    assertEquals(output.writeCursor, 4);

    const updatedProfile = makeProfile({
      workspaceId: initialProfile.workspaceId,
      alias: "alpha-renamed",
      workspaceRoot: resolve(".test-tmp", "workspace-output-state-renamed"),
      resolvedDefaultOutputDir: resolve(
        ".test-tmp",
        "workspace-output-state-renamed",
        "exports",
      ),
      configPath: resolve(
        ".test-tmp",
        "workspace-output-state-renamed",
        ".kato",
        "workspace.yaml",
      ),
      filenameTemplate: "{timestampHumane}-{provider}.md",
      defaultTags: ["updated", "shared"],
      writerFeatureFlags: createDefaultWorkspaceWriterFeatureFlags({
        writerIncludeCommentary: false,
      }),
    });
    output.recordingCycles.push({
      recordingCycleId: "cycle-existing",
      startedCursor: 1,
      startedAt: "2026-02-22T09:59:00.000Z",
    });

    output.outputMetadata = {
      displayTitle: "Pinned Title",
      tags: ["alpha-tag"],
    };
    output.writerFeatureFlagOverrides = {
      writerIncludeThinking: false,
    };

    applyWorkspaceProfileSnapshot(
      output,
      updatedProfile,
      updatedProfile.resolvedDefaultOutputDir,
    );

    assertEquals(output.workspaceAliasSnapshot, "alpha-renamed");
    assertEquals(output.sourceConfigPath, updatedProfile.configPath);
    assertEquals(output.workspaceRootSnapshot, updatedProfile.workspaceRoot);
    assertEquals(
      output.resolvedDefaultOutputDir,
      updatedProfile.resolvedDefaultOutputDir,
    );
    assertEquals(output.filenameTemplate, "{timestampHumane}-{provider}.md");
    assertEquals(output.defaultTags, ["updated", "shared"]);
    assertEquals(output.writerFeatureFlags.writerIncludeCommentary, false);
    assertEquals(output.recordingCycles.length, 1);
    assertEquals(output.outputMetadata, {
      displayTitle: "Pinned Title",
      tags: ["alpha-tag"],
    });
    assertEquals(output.writerFeatureFlagOverrides, {
      writerIncludeThinking: false,
    });
  },
);

Deno.test(
  "openWorkspaceOutputCycle, updateWorkspaceOutputCycleLastWrite, and closeWorkspaceOutputCycle track cycle timestamps",
  () => {
    const output = makeOutputState(makeProfile());

    const cycleId = openWorkspaceOutputCycle(
      output,
      7,
      "2026-02-22T10:01:00.000Z",
      "cycle-1",
    );
    assertEquals(cycleId, "cycle-1");
    assertEquals(output.desiredState, "on");
    assertEquals(output.activeRecordingCycleId, "cycle-1");
    assertEquals(output.recordingCycles[0]?.startedCursor, 7);
    assertEquals(output.recordingCycles[0]?.startedBySeq, 7);
    assertEquals(
      output.recordingCycles[0]?.lastWriteAt,
      "2026-02-22T10:01:00.000Z",
    );
    assertEquals(
      updateWorkspaceOutputCycleLastWrite(
        output,
        "2026-02-22T10:01:30.000Z",
        "cycle-1",
      ),
      true,
    );
    assertEquals(
      output.recordingCycles[0]?.lastWriteAt,
      "2026-02-22T10:01:30.000Z",
    );

    assertEquals(
      closeWorkspaceOutputCycle(output, 9, "2026-02-22T10:02:00.000Z"),
      true,
    );
    assertEquals(output.desiredState, "off");
    assertEquals(output.activeRecordingCycleId, undefined);
    assertEquals(output.recordingCycles[0]?.stoppedCursor, 9);
    assertEquals(output.recordingCycles[0]?.stoppedBySeq, 9);
    assertEquals(
      output.recordingCycles[0]?.stoppedAt,
      "2026-02-22T10:02:00.000Z",
    );
    assertEquals(
      output.recordingCycles[0]?.lastWriteAt,
      "2026-02-22T10:01:30.000Z",
    );
  },
);

Deno.test(
  "closeWorkspaceOutputCycle handles missing pointers and stopAllWorkspaceOutputs reports changed outputs",
  () => {
    const alpha = makeProfile({ alias: "alpha" });
    const beta = makeProfile({
      alias: "beta",
      workspaceRoot: resolve(".test-tmp", "workspace-output-state-beta"),
    });

    const missingPointer = makeOutputState(alpha, {
      desiredState: "on",
      recordingCycles: [{
        recordingCycleId: "cycle-missing-pointer",
        startedCursor: 1,
        startedAt: "2026-02-22T09:59:00.000Z",
      }],
    });
    assertEquals(
      closeWorkspaceOutputCycle(
        missingPointer,
        5,
        "2026-02-22T10:03:00.000Z",
      ),
      true,
    );
    assertEquals(missingPointer.desiredState, "off");
    assertEquals(missingPointer.activeRecordingCycleId, undefined);
    assertEquals(missingPointer.recordingCycles[0]?.stoppedCursor, undefined);
    assertEquals(
      closeWorkspaceOutputCycle(
        missingPointer,
        6,
        "2026-02-22T10:04:00.000Z",
      ),
      false,
    );

    const tracked = makeOutputState(alpha, {
      desiredState: "on",
      activeRecordingCycleId: "cycle-active",
      recordingCycles: [{
        recordingCycleId: "cycle-active",
        startedCursor: 2,
        startedAt: "2026-02-22T10:00:00.000Z",
      }],
    });
    const idle = makeOutputState(beta, { desiredState: "off" });
    const metadata = makeMetadata({
      workspaceOutputs: [tracked, idle],
    });

    assertEquals(
      stopAllWorkspaceOutputs(metadata, 7, "2026-02-22T10:05:00.000Z"),
      [alpha.workspaceId],
    );
    assertEquals(tracked.recordingCycles[0]?.stoppedCursor, 7);
    assertEquals(activeWorkspaceOutputs(metadata), []);
  },
);
