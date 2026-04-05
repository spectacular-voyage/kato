import { assertArrayIncludes, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveDendronWikilinkContext } from "../apps/runtime/src/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

Deno.test(
  "resolveDendronWikilinkContext skips nonmatching ancestor configs and keeps the first matching workspace",
  async () => {
    await withTestTempDir("workspace-dendron-context-", async (root) => {
      const projectRoot = join(root, "project");
      const projectNotesRoot = join(projectRoot, "notes");
      const outputPath = join(projectNotesRoot, "session.md");

      await Deno.mkdir(projectNotesRoot, { recursive: true });
      await Deno.writeTextFile(
        join(projectRoot, "dendron.yml"),
        [
          "workspace:",
          "  vaults:",
          "    - fsPath: docs",
          "      selfContained: false",
        ].join("\n") + "\n",
      );
      await Deno.writeTextFile(
        join(root, "dendron.yml"),
        [
          "workspace:",
          "  vaults:",
          "    - fsPath: project",
          "      selfContained: true",
        ].join("\n") + "\n",
      );

      const context = await resolveDendronWikilinkContext(outputPath);

      assertEquals(context.mode, "dendron-config");
      assertEquals(context.dendronConfigPath, join(root, "dendron.yml"));
      assertEquals(context.wikilinkifiableRoots, [projectNotesRoot]);
    });
  },
);

Deno.test(
  "resolveDendronWikilinkContext returns all eligible note roots from the matched config",
  async () => {
    await withTestTempDir("workspace-dendron-multivault-", async (root) => {
      const alphaNotesRoot = join(root, "alpha", "notes");
      const sharedRoot = join(root, "shared-notes");
      const missingSelfContainedRoot = join(root, "missing-self-contained");
      const outputPath = join(alphaNotesRoot, "session.md");

      await Deno.mkdir(alphaNotesRoot, { recursive: true });
      await Deno.mkdir(sharedRoot, { recursive: true });
      await Deno.mkdir(missingSelfContainedRoot, { recursive: true });
      await Deno.writeTextFile(
        join(root, "dendron.yml"),
        [
          "workspace:",
          "  vaults:",
          "    - fsPath: alpha",
          "      selfContained: true",
          "    - fsPath: shared-notes",
          "      selfContained: false",
          "    - fsPath: missing-self-contained",
          "      selfContained: true",
        ].join("\n") + "\n",
      );

      const context = await resolveDendronWikilinkContext(outputPath);

      assertEquals(context.mode, "dendron-config");
      assertEquals(context.dendronConfigPath, join(root, "dendron.yml"));
      assertArrayIncludes(context.wikilinkifiableRoots, [
        alphaNotesRoot,
        sharedRoot,
      ]);
      assertEquals(
        context.wikilinkifiableRoots.includes(
          join(missingSelfContainedRoot, "notes"),
        ),
        false,
      );
    });
  },
);

Deno.test(
  "resolveDendronWikilinkContext falls back to the output directory when no config matches",
  async () => {
    await withTestTempDir("workspace-dendron-fallback-", async (root) => {
      const outputDir = join(root, "alpha", "notes");
      const outputPath = join(outputDir, "session.md");
      await Deno.mkdir(outputDir, { recursive: true });

      const context = await resolveDendronWikilinkContext(outputPath);

      assertEquals(context.mode, "output-directory-fallback");
      assertEquals(context.dendronConfigPath, undefined);
      assertEquals(context.wikilinkifiableRoots, [outputDir]);
    });
  },
);
