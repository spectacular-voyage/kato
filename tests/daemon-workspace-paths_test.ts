import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  renderWorkspaceFilename,
  resolveWorkspaceDefaultOutputDir,
  type WorkspacePathTemplateProfile,
} from "../apps/daemon/src/orchestrator/runtime_workspace_paths.ts";

function makeBoundarySnapshot(content: string): ConversationEvent[] {
  return [{
    eventId: "event-1",
    provider: "codex",
    sessionId: "session-1",
    timestamp: "2026-02-22T19:00:00.000Z",
    kind: "message.user",
    role: "user",
    content,
    source: {
      providerEventType: "user",
      providerEventId: "event-1",
    },
  } as ConversationEvent];
}

function makeProfile(
  overrides: Partial<WorkspacePathTemplateProfile> = {},
): WorkspacePathTemplateProfile {
  return {
    workspaceRoot: resolve(".test-tmp", "workspace-paths"),
    defaultOutputDirTemplate: "notes",
    filenameTemplate: "{timestampHumane}-{snippetSlug}-{provider}.md",
    workspaceTimezone: "America/Los_Angeles",
    ...overrides,
  };
}

Deno.test(
  "renderWorkspaceFilename renders timestampHumane and snippetSlug with workspace timezone tokens",
  () => {
    const boundarySnapshot = makeBoundarySnapshot("\n\n  Leading Snippet");

    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-winter",
        now: new Date("2026-01-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot,
      }),
      "2026-01-15_1200-leading-snippet-codex.md",
    );

    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-summer",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot,
      }),
      "2026-07-15_1300-leading-snippet-codex.md",
    );

    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile({
          filenameTemplate:
            "conv.{YYYY}.{YY}-{MM}-{DD}_{HH}{mm}-{snippetSlug}-{provider}.md",
        }),
        provider: "codex",
        sessionId: "session-filename-components",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot,
      }),
      "conv.2026.26-07-15_1300-leading-snippet-codex.md",
    );
  },
);

Deno.test(
  "renderWorkspaceFilename falls back to conversation when snippet slug is empty",
  () => {
    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-fallback",
        now: new Date("2026-02-22T10:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: makeBoundarySnapshot("!!! ???"),
      }),
      "2026-02-22_0200-conversation-codex.md",
    );
  },
);

Deno.test(
  "resolveWorkspaceDefaultOutputDir applies template tokens for relative and absolute paths",
  () => {
    const relativeProfile = makeProfile({
      defaultOutputDirTemplate: "notes/{provider}/{YYYY}/{snippetSlug}",
    });
    assertEquals(
      resolveWorkspaceDefaultOutputDir({
        profile: relativeProfile,
        provider: "codex",
        sessionId: "session-dir-relative",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: makeBoundarySnapshot("\n\n  Leading Snippet"),
      }),
      resolve(
        relativeProfile.workspaceRoot,
        "notes",
        "codex",
        "2026",
        "leading-snippet",
      ),
    );

    const absoluteProfile = makeProfile({
      defaultOutputDirTemplate: resolve(
        relativeProfile.workspaceRoot,
        "..",
        "exports",
        "{provider}",
        "{username}",
      ),
    });
    assertEquals(
      resolveWorkspaceDefaultOutputDir({
        profile: absoluteProfile,
        provider: "codex",
        sessionId: "session-dir-absolute",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: makeBoundarySnapshot("\n\n  Leading Snippet"),
      }),
      resolve(
        relativeProfile.workspaceRoot,
        "..",
        "exports",
        "codex",
        "jane-user",
      ),
    );
  },
);
