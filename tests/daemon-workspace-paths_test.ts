import { assertEquals, assertThrows } from "@std/assert";
import { resolve } from "@std/path";
import type { ConversationEvent } from "@kato/shared";
import {
  renderWorkspaceFilename,
  resolveWorkspaceDefaultOutputDir,
  type WorkspacePathTemplateProfile,
} from "../apps/runtime/src/mod.ts";

function makeBoundaryEvent(
  content: string,
  options: { eventId?: string; timestamp?: string } = {},
): ConversationEvent {
  return {
    eventId: options.eventId ?? "event-1",
    provider: "codex",
    sessionId: "session-1",
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    kind: "message.user",
    role: "user",
    content,
    source: {
      providerEventType: "user",
      providerEventId: options.eventId ?? "event-1",
    },
  } as ConversationEvent;
}

function makeBoundarySnapshot(content: string): ConversationEvent[] {
  return [makeBoundaryEvent(content)];
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
  "renderWorkspaceFilename derives timestamp tokens from the newest timestamped event",
  () => {
    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-event-timestamp",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: [
          makeBoundaryEvent("Leading Snippet", {
            eventId: "event-1",
            timestamp: "2026-02-22T19:00:00.000Z",
          }),
          makeBoundaryEvent("newer message", {
            eventId: "event-2",
            timestamp: "2026-03-01T18:30:00.000Z",
          }),
        ],
      }),
      "2026-03-01_1030-leading-snippet-codex.md",
    );

    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-untimestamped-tail",
        now: new Date("2026-07-15T20:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: [
          makeBoundaryEvent("Leading Snippet", {
            eventId: "event-1",
            timestamp: "2026-02-22T19:00:00.000Z",
          }),
          makeBoundaryEvent("untimestamped tail", { eventId: "event-2" }),
        ],
      }),
      "2026-02-22_1100-leading-snippet-codex.md",
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
  "renderWorkspaceFilename uses custom filename slug before extracted snippet",
  () => {
    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-custom-slug",
        now: new Date("2026-02-22T10:00:00.000Z"),
        outputUsername: "Jane User",
        filenameSlug: "Better Conversation Name",
        boundarySnapshot: makeBoundarySnapshot("bad first line"),
      }),
      "2026-02-22_0200-better-conversation-name-codex.md",
    );
  },
);

Deno.test(
  "renderWorkspaceFilename falls back to extracted snippet when custom filename slug is unsafe",
  () => {
    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile(),
        provider: "codex",
        sessionId: "session-filename-custom-slug-unsafe",
        now: new Date("2026-02-22T10:00:00.000Z"),
        outputUsername: "Jane User",
        filenameSlug: "!!! ???",
        boundarySnapshot: makeBoundarySnapshot("Helpful fallback"),
      }),
      "2026-02-22_0200-helpful-fallback-codex.md",
    );
  },
);

Deno.test(
  "renderWorkspaceFilename falls back when normalization collapses to dot segments",
  () => {
    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile({ filenameTemplate: "." }),
        provider: "codex",
        sessionId: "session-filename-dot",
        now: new Date("2026-02-22T10:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: makeBoundarySnapshot("Leading Snippet"),
      }),
      "2026-02-22_0200-leading-snippet-codex.md",
    );

    assertEquals(
      renderWorkspaceFilename({
        profile: makeProfile({ filenameTemplate: ".." }),
        provider: "codex",
        sessionId: "session-filename-dotdot",
        now: new Date("2026-02-22T10:00:00.000Z"),
        outputUsername: "Jane User",
        boundarySnapshot: makeBoundarySnapshot("Leading Snippet"),
      }),
      "2026-02-22_0200-leading-snippet-codex.md",
    );
  },
);

Deno.test(
  "resolveWorkspaceDefaultOutputDir applies template tokens for relative and absolute paths within the workspace root",
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
        "exports",
        "codex",
        "jane-user",
      ),
    );
  },
);

Deno.test(
  "resolveWorkspaceDefaultOutputDir rejects relative and absolute defaults outside the workspace root",
  () => {
    assertThrows(
      () =>
        resolveWorkspaceDefaultOutputDir({
          profile: makeProfile({
            defaultOutputDirTemplate: "../exports/{provider}",
          }),
          provider: "codex",
          sessionId: "session-dir-relative-escape",
          now: new Date("2026-07-15T20:00:00.000Z"),
          outputUsername: "Jane User",
          boundarySnapshot: makeBoundarySnapshot("\n\n  Leading Snippet"),
        }),
      Error,
      "defaultOutputDir must resolve within the workspace root",
    );

    assertThrows(
      () =>
        resolveWorkspaceDefaultOutputDir({
          profile: makeProfile({
            defaultOutputDirTemplate: resolve(
              makeProfile().workspaceRoot,
              "..",
              "exports",
              "{provider}",
            ),
          }),
          provider: "codex",
          sessionId: "session-dir-absolute-escape",
          now: new Date("2026-07-15T20:00:00.000Z"),
          outputUsername: "Jane User",
          boundarySnapshot: makeBoundarySnapshot("\n\n  Leading Snippet"),
        }),
      Error,
      "defaultOutputDir must resolve within the workspace root",
    );
  },
);
