import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  DEFAULT_WORKSPACE_CONFIG_FILENAME,
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
  type RegisteredWorkspace,
} from "../apps/runtime/src/mod.ts";
import {
  buildWorkspaceStatusSummary,
  loadWorkspaceStatusSummary,
} from "../apps/cli/src/commands/status_workspace.ts";
import { withTestTempDir } from "./test_temp.ts";

function makeWorkspaceEntry(
  workspaceId: string,
  alias: string,
  workspaceRoot: string,
): RegisteredWorkspace {
  return {
    workspaceId,
    alias,
    workspaceRoot,
    configPath: join(workspaceRoot, DEFAULT_WORKSPACE_CONFIG_FILENAME),
    registeredAt: "2026-03-02T10:00:00.000Z",
  };
}

Deno.test(
  "buildWorkspaceStatusSummary sorts rows and validates real workspace configs",
  async () => {
    await withTestTempDir("status-workspace-summary-", async (tempDir) => {
      const validWorkspace = join(tempDir, "Zulu.Proj");
      const invalidWorkspace = join(tempDir, "Alpha.Proj");
      const validEntry = makeWorkspaceEntry(
        "ws-valid",
        "Zulu.Proj",
        validWorkspace,
      );
      const invalidEntry = makeWorkspaceEntry(
        "ws-invalid",
        "Alpha.Proj",
        invalidWorkspace,
      );

      await Deno.mkdir(validWorkspace, { recursive: true });
      await Deno.mkdir(invalidWorkspace, { recursive: true });
      await Deno.writeTextFile(
        validEntry.configPath,
        [
          "workspaceId: ws-valid",
          'defaultOutputDir: "."',
        ].join("\n") + "\n",
      );
      await Deno.writeTextFile(
        invalidEntry.configPath,
        [
          "workspaceId: ws-invalid",
          "featureFlags:",
          "  writerIncludeCommentary: true",
        ].join("\n") + "\n",
      );

      const summary = await buildWorkspaceStatusSummary(
        [validEntry, invalidEntry],
        {
          loadWorkspaceConfigOverrides,
          readWorkspaceConfigWorkspaceId,
        },
      );

      assertEquals(summary.activeCount, 1);
      assertEquals(summary.invalidCount, 1);
      assertEquals(
        summary.rows.map((row) => row.alias),
        ["Alpha.Proj", "Zulu.Proj"],
      );
      assertEquals(summary.rows[0]?.valid, false);
      assertStringIncludes(
        summary.rows[0]?.invalidReason ?? "",
        "Unsupported workspace config key 'featureFlags'",
      );
      assertEquals(summary.rows[1]?.valid, true);
      assertEquals(summary.rows[1]?.invalidReason, undefined);
    });
  },
);

Deno.test(
  "buildWorkspaceStatusSummary marks workspaceId mismatches invalid",
  async () => {
    await withTestTempDir("status-workspace-mismatch-", async (tempDir) => {
      const workspaceRoot = join(tempDir, "Mismatch.Proj");
      const entry = makeWorkspaceEntry(
        "registry-workspace-id",
        "Mismatch.Proj",
        workspaceRoot,
      );

      await Deno.mkdir(workspaceRoot, { recursive: true });
      await Deno.writeTextFile(
        entry.configPath,
        [
          "workspaceId: config-workspace-id",
          'defaultOutputDir: "."',
        ].join("\n") + "\n",
      );

      const summary = await buildWorkspaceStatusSummary([entry], {
        loadWorkspaceConfigOverrides,
        readWorkspaceConfigWorkspaceId,
      });

      assertEquals(summary.activeCount, 0);
      assertEquals(summary.invalidCount, 1);
      assertEquals(summary.rows[0]?.valid, false);
      assertEquals(
        summary.rows[0]?.invalidReason,
        "workspaceId mismatch (registry=registry-workspace-id, config=config-workspace-id)",
      );
    });
  },
);

Deno.test(
  "buildWorkspaceStatusSummary marks missing config files as not found",
  async () => {
    await withTestTempDir("status-workspace-missing-", async (tempDir) => {
      const entry = makeWorkspaceEntry(
        "ws-missing",
        "Missing.Proj",
        join(tempDir, "Missing.Proj"),
      );

      const summary = await buildWorkspaceStatusSummary([entry], {
        loadWorkspaceConfigOverrides,
        readWorkspaceConfigWorkspaceId,
      });

      assertEquals(summary.activeCount, 0);
      assertEquals(summary.invalidCount, 1);
      assertEquals(summary.rows[0]?.valid, false);
      assertEquals(summary.rows[0]?.invalidReason, "config file not found");
    });
  },
);

Deno.test(
  "loadWorkspaceStatusSummary reports unavailableReason when registry load fails",
  async () => {
    const summary = await loadWorkspaceStatusSummary(
      () => Promise.reject(new Deno.errors.PermissionDenied("blocked")),
      {
        loadWorkspaceConfigOverrides,
        readWorkspaceConfigWorkspaceId,
      },
    );

    assertEquals(summary, {
      activeCount: 0,
      invalidCount: 0,
      rows: [],
      unavailableReason: "permission denied while reading workspace registry",
    });
  },
);

Deno.test(
  "loadWorkspaceStatusSummary distinguishes missing registry from missing workspace config",
  async () => {
    const summary = await loadWorkspaceStatusSummary(
      () => Promise.reject(new Deno.errors.NotFound("missing")),
      {
        loadWorkspaceConfigOverrides,
        readWorkspaceConfigWorkspaceId,
      },
    );

    assertEquals(summary, {
      activeCount: 0,
      invalidCount: 0,
      rows: [],
      unavailableReason: "workspace registry file not found",
    });
  },
);
