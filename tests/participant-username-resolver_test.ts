import { assertEquals } from "@std/assert";
import {
  createDefaultRuntimeMarkdownFrontmatterConfig,
  createDefaultUserConfig,
  resolveFrontmatterParticipantUsername,
} from "../apps/daemon/src/mod.ts";
import { withLockedEnvironment } from "./test_env.ts";

Deno.test("resolveFrontmatterParticipantUsername respects exclude > workspace map > default > omit", () => {
  const markdownFrontmatter = createDefaultRuntimeMarkdownFrontmatterConfig({
    addParticipantUsernameToFrontmatter: true,
  });

  const excluded = createDefaultUserConfig({
    defaultUsername: "Default.User",
    workspaceUsernames: {
      "workspace-1": "Workspace.User",
    },
    excludeMeFromParticipantList: true,
  });
  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter,
      userConfig: excluded,
      workspaceId: "workspace-1",
    }),
    undefined,
  );

  const workspaceMapped = createDefaultUserConfig({
    defaultUsername: "Default.User",
    workspaceUsernames: {
      "workspace-1": "Workspace.User",
    },
    excludeMeFromParticipantList: false,
  });
  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter,
      userConfig: workspaceMapped,
      workspaceId: "workspace-1",
    }),
    "Workspace.User",
  );

  const defaultOnly = createDefaultUserConfig({
    defaultUsername: "Default.User",
    workspaceUsernames: {},
    excludeMeFromParticipantList: false,
  });
  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter,
      userConfig: defaultOnly,
      workspaceId: "workspace-1",
    }),
    "Default.User",
  );

  const noConfiguredUsername = createDefaultUserConfig({
    defaultUsername: "",
    workspaceUsernames: {},
    excludeMeFromParticipantList: false,
  });
  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter,
      userConfig: noConfiguredUsername,
      workspaceId: "workspace-1",
    }),
    undefined,
  );
});

Deno.test("resolveFrontmatterParticipantUsername ignores prototype workspace mappings", () => {
  const markdownFrontmatter = createDefaultRuntimeMarkdownFrontmatterConfig({
    addParticipantUsernameToFrontmatter: true,
  });
  const userConfig = createDefaultUserConfig({
    defaultUsername: "Default.User",
    workspaceUsernames: {},
    excludeMeFromParticipantList: false,
  });

  userConfig.participants.workspaceUsernames = Object.create({
    "workspace-1": "Prototype.User",
  }) as Record<string, string>;

  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter,
      userConfig,
      workspaceId: "workspace-1",
    }),
    "Default.User",
  );
});

Deno.test("resolveFrontmatterParticipantUsername omits user when addParticipantUsernameToFrontmatter is false", () => {
  const disabled = createDefaultRuntimeMarkdownFrontmatterConfig({
    addParticipantUsernameToFrontmatter: false,
  });
  const userConfig = createDefaultUserConfig({
    defaultUsername: "Default.User",
    excludeMeFromParticipantList: false,
  });

  assertEquals(
    resolveFrontmatterParticipantUsername({
      markdownFrontmatter: disabled,
      userConfig,
      workspaceId: "workspace-1",
    }),
    undefined,
  );
});

Deno.test("resolveFrontmatterParticipantUsername has no env/home fallback path", async () => {
  await withLockedEnvironment(() => {
    const markdownFrontmatter = createDefaultRuntimeMarkdownFrontmatterConfig({
      addParticipantUsernameToFrontmatter: true,
    });
    const userConfig = createDefaultUserConfig({
      defaultUsername: "",
      workspaceUsernames: {},
      excludeMeFromParticipantList: false,
    });
    const originalHome = Deno.env.get("HOME");

    try {
      Deno.env.set("HOME", "/tmp/some-user-home");
      assertEquals(
        resolveFrontmatterParticipantUsername({
          markdownFrontmatter,
          userConfig,
        }),
        undefined,
      );
    } finally {
      if (originalHome === undefined) {
        Deno.env.delete("HOME");
      } else {
        Deno.env.set("HOME", originalHome);
      }
    }
  });
});
