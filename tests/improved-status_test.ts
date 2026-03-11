import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { DaemonSessionStatus, DaemonStatusSnapshot } from "@kato/shared";
import { CliUsageError, parseDaemonCliArgs } from "../apps/cli/src/mod.ts";
import {
  getStatusRecentErrorKey,
  isLiveExitKey,
  isLiveFlushKey,
  renderStatusText,
  type StatusRecentError,
  type StatusWebState,
  type WorkspaceStatusSummary,
} from "../apps/cli/src/commands/status.ts";
import { CLI_APP_VERSION } from "../apps/cli/src/version.ts";
import { toStatusViewModel } from "../apps/web/src/main.ts";

// ─── Parser tests ─────────────────────────────────────────────────────────────

Deno.test("cli parser: status --all parses all=true live=false", () => {
  const intent = parseDaemonCliArgs(["status", "--all"]);
  assertEquals(intent.kind, "command");
  if (intent.kind !== "command") throw new Error("expected command intent");
  assertEquals(intent.command.name, "status");
  if (intent.command.name !== "status") {
    throw new Error("expected status command");
  }
  assertEquals(intent.command.all, true);
  assertEquals(intent.command.live, false);
});

Deno.test("cli parser: status --live parses live=true all=true (implied)", () => {
  const intent = parseDaemonCliArgs(["status", "--live"]);
  assertEquals(intent.kind, "command");
  if (intent.kind !== "command") throw new Error("expected command intent");
  assertEquals(intent.command.name, "status");
  if (intent.command.name !== "status") {
    throw new Error("expected status command");
  }
  assertEquals(intent.command.live, true);
  assertEquals(intent.command.all, true);
});

Deno.test("cli parser: status --json --all parses both", () => {
  const intent = parseDaemonCliArgs(["status", "--json", "--all"]);
  assertEquals(intent.kind, "command");
  if (intent.kind !== "command") throw new Error("expected command intent");
  assertEquals(intent.command.name, "status");
  if (intent.command.name !== "status") {
    throw new Error("expected status command");
  }
  assertEquals(intent.command.asJson, true);
  assertEquals(intent.command.all, true);
  assertEquals(intent.command.live, false);
});

Deno.test("cli parser: status --unknown-flag throws CliUsageError", () => {
  assertThrows(
    () => parseDaemonCliArgs(["status", "--bogus"]),
    CliUsageError,
  );
});

Deno.test("cli parser: plain status parses all=false live=false", () => {
  const intent = parseDaemonCliArgs(["status"]);
  assertEquals(intent.kind, "command");
  if (intent.kind !== "command") throw new Error("expected command intent");
  assertEquals(intent.command.name, "status");
  if (intent.command.name !== "status") {
    throw new Error("expected status command");
  }
  assertEquals(intent.command.all, false);
  assertEquals(intent.command.live, false);
  assertEquals(intent.command.asJson, false);
});

Deno.test("isLiveExitKey: q, Q, and Ctrl+C exit live mode", () => {
  assertEquals(isLiveExitKey(113), true);
  assertEquals(isLiveExitKey(81), true);
  assertEquals(isLiveExitKey(3), true);
});

Deno.test("isLiveExitKey: non-exit keys do not exit live mode", () => {
  assertEquals(isLiveExitKey(102), false);
  assertEquals(isLiveExitKey(10), false);
  assertEquals(isLiveExitKey(32), false);
});

Deno.test("isLiveFlushKey: f and F trigger live error flush", () => {
  assertEquals(isLiveFlushKey(102), true);
  assertEquals(isLiveFlushKey(70), true);
  assertEquals(isLiveFlushKey(113), false);
  assertEquals(isLiveFlushKey(3), false);
});

// ─── renderStatusText ─────────────────────────────────────────────────────────

function makeSnapshot(
  sessions?: DaemonSessionStatus[],
  overBudget = false,
): DaemonStatusSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-02-24T10:00:00.000Z",
    heartbeatAt: "2026-02-24T10:00:00.000Z",
    daemonRunning: true,
    daemonPid: 1234,
    providers: [],
    recordings: { activeRecordings: 0, destinations: 0 },
    sessions,
    memory: {
      daemonMaxMemoryBytes: 200 * 1024 * 1024,
      process: {
        rss: 80 * 1024 * 1024,
        heapTotal: 60 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 1 * 1024 * 1024,
      },
      snapshots: {
        estimatedBytes: 20 * 1024 * 1024,
        sessionCount: 3,
        eventCount: 150,
        evictionsTotal: 0,
        bytesReclaimedTotal: 0,
        evictionsByReason: {},
        overBudget,
      },
    },
  };
}

const NOW = new Date("2026-02-24T10:00:00.000Z");

Deno.test("renderStatusText: no sessions shows (none)", () => {
  const out = renderStatusText(makeSnapshot([]), {
    showAll: false,
    now: NOW,
    stale: false,
  });
  assertStringIncludes(out, `kato CLI (v${CLI_APP_VERSION})`);
  assertStringIncludes(out, "kato daemon");
  assertStringIncludes(out, "Sessions");
  assertStringIncludes(out, "(none");
});

Deno.test(
  "renderStatusText: no recent errors renders only the section heading",
  () => {
    const sessions: DaemonSessionStatus[] = [{
      provider: "claude",
      sessionId: "recent-errors-empty",
      snippet: "status",
      updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      lastEventAt: new Date(NOW.getTime() - 60_000).toISOString(),
      stale: false,
      recordings: [{
        workspaceAlias: "k",
        outputPath: "/home/user/notes.md",
        startedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
        lastWriteAt: new Date(NOW.getTime() - 60_000).toISOString(),
      }],
    }];
    const out = renderStatusText(makeSnapshot(sessions), {
      showAll: false,
      now: NOW,
      stale: false,
      terminalWidth: 160,
    });
    assertStringIncludes(out, "Recent Errors (0)");
    assertEquals(out.includes("Recent Errors (0)\n\n"), false);
    assertEquals(out.includes("Recent Errors (0)\n  (none)"), false);
  },
);

Deno.test("renderStatusText: active session shown with bullet marker", () => {
  const sessions: DaemonSessionStatus[] = [{
    provider: "claude",
    sessionId: "abc123",
    snippet: "how do I configure X",
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    lastEventAt: new Date(NOW.getTime() - 60_000).toISOString(),
    stale: false,
    recordings: [{
      workspaceAlias: "k",
      outputPath: "/home/user/notes.md",
      startedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      lastWriteAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }],
  }];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: false,
    now: NOW,
    stale: false,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "● claude:");
  assertStringIncludes(out, "how do I configure X");
  assert(/updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(out));
  assertStringIncludes(out, "last event 1m ago");
  assertStringIncludes(out, "/home/user/notes.md");
  assertStringIncludes(out, "recording");
  assertStringIncludes(out, "workspace: k");
});

Deno.test("renderStatusText: recording detail line is shown before destination path", () => {
  const sessions: DaemonSessionStatus[] = [{
    provider: "claude",
    sessionId: "layout-ordered",
    snippet: "layout",
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    lastEventAt: new Date(NOW.getTime() - 60_000).toISOString(),
    stale: false,
    recordings: [{
      workspaceAlias: "k",
      outputPath: "/home/user/notes.md",
      startedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      lastWriteAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }],
  }];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: true,
    now: NOW,
    stale: false,
    terminalWidth: 160,
  });
  const lines = out.split("\n");
  const detailIndex = lines.findIndex((line) =>
    line.includes("recording (layout-ordered)") && line.includes("started")
  );
  const pathIndex = lines.findIndex((line) =>
    line.includes("-> /home/user/notes.md")
  );
  assert(detailIndex >= 0);
  assert(pathIndex >= 0);
  assert(detailIndex < pathIndex);
});

Deno.test("renderStatusText: recording workspace alias strips ANSI and controls", () => {
  const sessions: DaemonSessionStatus[] = [{
    provider: "claude",
    sessionId: "ansi-alias",
    snippet: "status",
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    lastEventAt: new Date(NOW.getTime() - 60_000).toISOString(),
    stale: false,
    recordings: [{
      workspaceAlias: "  \u001b[31mMy\u001b[0m\tProj\n\u0007  ",
      outputPath: "/home/user/notes.md",
      startedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      lastWriteAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }],
  }];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: false,
    now: NOW,
    stale: false,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "workspace: My Proj");
  assertEquals(out.includes("\u001b["), false);
});

Deno.test("renderStatusText: recent errors section renders warn/error records", () => {
  const recentErrors: StatusRecentError[] = [{
    timestamp: "2026-02-24T09:59:30.000Z",
    level: "error",
    channel: "operational",
    event: "provider.ingestion.read_denied",
    message: "permission denied",
  }, {
    timestamp: "2026-02-24T09:59:00.000Z",
    level: "error",
    channel: "security-audit",
    event: "recording.command.failed",
    message: "capture destination already exists",
  }];
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    recentErrors,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "Recent Errors (2)");
  assertStringIncludes(out, "ERROR operational provider.ingestion.read_denied");
  assertStringIncludes(out, "ERROR audit recording.command.failed");
  assertStringIncludes(out, "permission denied");
  assertStringIncludes(out, "capture destination already exists");
});

Deno.test("renderStatusText: web status and web recent errors are labeled distinctly", () => {
  const recentErrors: StatusRecentError[] = [{
    timestamp: "2026-02-24T09:59:30.000Z",
    level: "error",
    channel: "operational",
    event: "web.settings.mutation.failed",
    message: "invalid username",
    scope: "web",
  }];
  const webStatus: StatusWebState = {
    configured: true,
    running: true,
    stale: false,
    state: "running",
    version: CLI_APP_VERSION,
    url: "http://127.0.0.1:3173/",
    pid: 4242,
  };
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    recentErrors,
    webStatus,
    terminalWidth: 160,
  });
  assertStringIncludes(
    out,
    `kato web (v${CLI_APP_VERSION}): running (http://127.0.0.1:3173/, pid 4242)`,
  );
  assertStringIncludes(
    out,
    "ERROR web operational web.settings.mutation.failed",
  );
  assertStringIncludes(out, "invalid username");
});

Deno.test("renderStatusText: suppressedRecentErrorKeys hides matching errors", () => {
  const recentErrors: StatusRecentError[] = [{
    timestamp: "2026-02-24T09:59:30.000Z",
    level: "error",
    channel: "operational",
    event: "provider.ingestion.read_denied",
    message: "permission denied",
    source: "log",
  }, {
    timestamp: "2026-02-24T09:59:00.000Z",
    level: "error",
    channel: "security-audit",
    event: "recording.command.failed",
    message: "capture destination already exists",
    source: "log",
  }];
  const suppressedRecentErrorKeys = new Set<string>([
    getStatusRecentErrorKey(recentErrors[0]),
  ]);
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    recentErrors,
    suppressedRecentErrorKeys,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "Recent Errors (1)");
  assertEquals(out.includes("provider.ingestion.read_denied"), false);
  assertStringIncludes(out, "ERROR audit recording.command.failed");
});

Deno.test("getStatusRecentErrorKey: workspace errors ignore timestamp", () => {
  const first: StatusRecentError = {
    timestamp: "2026-02-24T09:59:30.000Z",
    level: "error",
    channel: "operational",
    event: "workspace.config.invalid",
    message: "Broken.Proj (ws-invalid): invalid workspace configuration",
    source: "workspace",
  };
  const second: StatusRecentError = {
    ...first,
    timestamp: "2026-02-24T10:03:00.000Z",
  };
  assertEquals(getStatusRecentErrorKey(first), getStatusRecentErrorKey(second));
});

Deno.test("renderStatusText: invalid workspace rows are promoted into Recent Errors", () => {
  const workspaceStatus: WorkspaceStatusSummary = {
    activeCount: 0,
    invalidCount: 1,
    rows: [{
      workspaceId: "ws-invalid",
      alias: "Broken.Proj",
      workspaceRoot: "/workspaces/Broken.Proj",
      configPath: "/workspaces/Broken.Proj/.kato-workspace-config.yaml",
      valid: false,
      invalidReason: "Unsupported workspace config key 'featureFlags'",
    }],
  };
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    workspaceStatus,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "Recent Errors (1)");
  assertStringIncludes(out, "ERROR operational workspace.config.invalid");
  assertStringIncludes(
    out,
    "Broken.Proj (ws-invalid): Unsupported workspace config key 'featureFlags'",
  );
});

Deno.test(
  "renderStatusText: duplicate workspace/log recent errors are deduped",
  () => {
    const workspaceStatus: WorkspaceStatusSummary = {
      activeCount: 0,
      invalidCount: 1,
      rows: [{
        workspaceId: "ws-invalid",
        alias: "Broken.Proj",
        workspaceRoot: "/workspaces/Broken.Proj",
        configPath: "/workspaces/Broken.Proj/.kato-workspace-config.yaml",
        valid: false,
        invalidReason: "Unsupported workspace config key 'featureFlags'",
      }],
    };
    const recentErrors: StatusRecentError[] = [{
      timestamp: "2026-02-24T09:59:30.000Z",
      level: "error",
      channel: "operational",
      event: "workspace.config.invalid",
      message:
        "Broken.Proj (ws-invalid): Unsupported workspace config key 'featureFlags'",
      source: "log",
    }];
    const out = renderStatusText(makeSnapshot([]), {
      showAll: true,
      now: NOW,
      stale: false,
      workspaceStatus,
      recentErrors,
      terminalWidth: 160,
    });
    assertStringIncludes(out, "Recent Errors (1)");
    assertEquals(
      out.split(
        "Broken.Proj (ws-invalid): Unsupported workspace config key 'featureFlags'",
      ).length - 1,
      1,
    );
  },
);

Deno.test(
  "renderStatusText: dedupe runs before final truncation so recent errors stay full",
  () => {
    const workspaceStatus: WorkspaceStatusSummary = {
      activeCount: 0,
      invalidCount: 1,
      rows: [{
        workspaceId: "ws-invalid",
        alias: "Broken.Proj",
        workspaceRoot: "/workspaces/Broken.Proj",
        configPath: "/workspaces/Broken.Proj/.kato-workspace-config.yaml",
        valid: false,
        invalidReason: "Unsupported workspace config key 'featureFlags'",
      }],
    };
    const recentErrors: StatusRecentError[] = [
      {
        timestamp: "2026-02-24T09:59:07.000Z",
        level: "error",
        channel: "operational",
        event: "provider.ingestion.read_denied",
        message: "permission denied",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:06.000Z",
        level: "error",
        channel: "security-audit",
        event: "recording.command.failed",
        message: "capture destination denied by policy",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:05.000Z",
        level: "error",
        channel: "operational",
        event: "workspace.config.invalid",
        message:
          "Broken.Proj (ws-invalid): Unsupported workspace config key 'featureFlags'",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:04.000Z",
        level: "error",
        channel: "operational",
        event: "event-4",
        message: "m4",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:03.000Z",
        level: "error",
        channel: "operational",
        event: "event-5",
        message: "m5",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:02.000Z",
        level: "error",
        channel: "operational",
        event: "event-6",
        message: "m6",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:01.000Z",
        level: "error",
        channel: "operational",
        event: "event-7",
        message: "m7",
        source: "log",
      },
      {
        timestamp: "2026-02-24T09:59:00.000Z",
        level: "error",
        channel: "operational",
        event: "event-8",
        message: "oldest-unique-marker",
        source: "log",
      },
    ];
    const out = renderStatusText(makeSnapshot([]), {
      showAll: true,
      now: NOW,
      stale: false,
      workspaceStatus,
      recentErrors,
      terminalWidth: 160,
    });
    assertStringIncludes(out, "Recent Errors (8)");
    assertStringIncludes(out, "oldest-unique-marker");
    assertEquals(
      out.split(
        "Broken.Proj (ws-invalid): Unsupported workspace config key 'featureFlags'",
      ).length - 1,
      1,
    );
  },
);

Deno.test(
  "renderStatusText: invalid workspace aliases in derived errors use a safe placeholder",
  () => {
    const workspaceStatus: WorkspaceStatusSummary = {
      activeCount: 0,
      invalidCount: 1,
      rows: [{
        workspaceId: "ws-invalid",
        alias: " \u001b[31m\u0007\u001b[0m ",
        workspaceRoot: "/workspaces/Broken.Proj",
        configPath: "/workspaces/Broken.Proj/.kato-workspace-config.yaml",
        valid: false,
        invalidReason: "invalid workspace alias",
      }],
    };
    const out = renderStatusText(makeSnapshot([]), {
      showAll: true,
      now: NOW,
      stale: false,
      workspaceStatus,
      terminalWidth: 160,
    });
    assertStringIncludes(
      out,
      "<redacted-alias> (ws-invalid): invalid workspace alias",
    );
    assertEquals(out.includes("\u001b["), false);
  },
);

Deno.test(
  "renderStatusText: keeps at least one log-backed recent error when derived errors are newer",
  () => {
    const recentErrors: StatusRecentError[] = [{
      timestamp: "2026-02-24T09:59:30.000Z",
      level: "error",
      channel: "operational",
      event: "provider.ingestion.read_denied",
      message: "permission denied",
    }];
    const workspaceStatus: WorkspaceStatusSummary = {
      activeCount: 0,
      invalidCount: 12,
      rows: Array.from({ length: 12 }, (_, index) => ({
        workspaceId: `ws-invalid-${index + 1}`,
        alias: `Broken-${index + 1}`,
        workspaceRoot: `/workspaces/Broken-${index + 1}`,
        configPath: `/workspaces/Broken-${
          index + 1
        }/.kato-workspace-config.yaml`,
        valid: false,
        invalidReason: `invalid workspace ${index + 1}`,
      })),
    };
    const out = renderStatusText(makeSnapshot([]), {
      showAll: true,
      now: NOW,
      stale: false,
      recentErrors,
      workspaceStatus,
      terminalWidth: 160,
    });
    assertStringIncludes(
      out,
      "ERROR operational provider.ingestion.read_denied",
    );
    assertStringIncludes(out, "permission denied");
  },
);

Deno.test("renderStatusText: missing lastEventAt omits last event segment", () => {
  const sessions: DaemonSessionStatus[] = [{
    provider: "claude",
    sessionId: "no-msg-time",
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    stale: true,
  }];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: true,
    now: NOW,
    stale: false,
  });
  assertStringIncludes(out, "(no-msg-time)  ·  updated ");
  assertEquals(out.includes("last event"), false);
});

Deno.test("renderStatusText: stale session hidden by default", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "active",
      updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      stale: false,
    },
    {
      provider: "codex",
      sessionId: "stale",
      updatedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      stale: true,
    },
  ];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: false,
    now: NOW,
    stale: false,
  });
  assertStringIncludes(out, "(active)  ·  updated ");
  assertEquals(out.includes("codex/stale"), false);
});

Deno.test("renderStatusText: --all includes stale session with circle marker", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "codex",
      sessionId: "stale",
      updatedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
      stale: true,
    },
  ];
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: true,
    now: NOW,
    stale: false,
  });
  assertStringIncludes(out, "○ codex:");
  assertStringIncludes(out, "no active recordings");
});

Deno.test("renderStatusText: memory summary line present", () => {
  const out = renderStatusText(makeSnapshot([]), {
    showAll: false,
    now: NOW,
    stale: false,
    terminalWidth: 140,
  });
  assertStringIncludes(out, "daemon memory:");
  assertStringIncludes(out, "MB /");
  assertStringIncludes(out, "session data size:");
});

Deno.test("renderStatusText: over-budget shows warning", () => {
  const out = renderStatusText(makeSnapshot([], true), {
    showAll: false,
    now: NOW,
    stale: false,
  });
  assertStringIncludes(out, "OVER BUDGET");
});

Deno.test("renderStatusText: sessionCap limits displayed sessions", () => {
  const sessions: DaemonSessionStatus[] = Array.from(
    { length: 10 },
    (_, i) => ({
      provider: "claude",
      sessionId: `s${i}`,
      updatedAt: new Date(NOW.getTime() - i * 60_000).toISOString(),
      stale: false,
    }),
  );
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: true,
    sessionCap: 3,
    now: NOW,
    stale: false,
  });
  // Should only mention the 3 most recent (s0, s1, s2)
  assertStringIncludes(out, "(s0)  ·  updated ");
  assertStringIncludes(out, "(s1)  ·  updated ");
  assertStringIncludes(out, "(s2)  ·  updated ");
  assertEquals(out.includes("(s3)  ·  updated "), false);
});

Deno.test("renderStatusText: narrow width keeps lines within width", () => {
  const sessions: DaemonSessionStatus[] = [{
    provider: "claude",
    sessionId: "abc123",
    snippet:
      "this is a long snippet that should be truncated when terminal width is very narrow",
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    stale: false,
    recordings: [{
      outputPath:
        "/home/user/really/long/path/to/a/file/that/should/be/truncated/in/narrow/view.md",
      startedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      lastWriteAt: new Date(NOW.getTime() - 60_000).toISOString(),
    }],
  }];
  const width = 60;
  const out = renderStatusText(makeSnapshot(sessions), {
    showAll: true,
    now: NOW,
    stale: false,
    terminalWidth: width,
  });
  const tooWideLine = out.split("\n").find((line) => line.length > width);
  assertEquals(tooWideLine, undefined);
  assertStringIncludes(out, "daemon memory:");
  assertStringIncludes(out, "recordings:");
  assertStringIncludes(out, "off");
});

Deno.test("renderStatusText: wide width keeps two-column summary", () => {
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    terminalWidth: 120,
  });
  assertStringIncludes(out, "kato daemon");
  assertStringIncludes(out, "daemon memory:");
  assertStringIncludes(out, "session data size:");
  const daemonLineCount =
    out.split("\n").filter((line) => line.includes("kato daemon")).length;
  assertEquals(daemonLineCount, 1);
  assert(
    out.split("\n").some((line) =>
      line.includes("recordings:") && line.includes("daemon memory:")
    ),
  );
  assertEquals(
    out.split("\n").some((line) => line.includes("session data size:")),
    true,
  );
});

Deno.test("renderStatusText: workspace summary line renders for live mode", () => {
  const workspaceStatus: WorkspaceStatusSummary = {
    activeCount: 1,
    invalidCount: 1,
    rows: [],
  };
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    workspaceStatus,
  });
  assertStringIncludes(out, "workspaces: 1 active, 1 invalid");
  assertEquals(out.includes("Workspaces ("), false);
});

Deno.test("renderStatusText: workspace detail section renders in non-live mode", () => {
  const workspaceStatus: WorkspaceStatusSummary = {
    activeCount: 1,
    invalidCount: 1,
    rows: [
      {
        workspaceId: "ws-valid",
        alias: "My.Proj",
        workspaceRoot: "/workspaces/My.Proj",
        configPath: "/workspaces/My.Proj/.kato-workspace-config.yaml",
        valid: true,
      },
      {
        workspaceId: "ws-invalid",
        alias: "Broken.Proj",
        workspaceRoot: "/workspaces/Broken.Proj",
        configPath: "/workspaces/Broken.Proj/.kato-workspace-config.yaml",
        valid: false,
        invalidReason: "Unsupported workspace config key 'featureFlags'",
      },
    ],
  };
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    workspaceStatus,
    showWorkspaceDetails: true,
    terminalWidth: 160,
  });
  assertStringIncludes(out, "workspaces: 1 active, 1 invalid");
  assertStringIncludes(out, "Workspaces (1 active, 1 invalid)");
  assertStringIncludes(out, "● My.Proj -> ws-valid (valid)");
  assertStringIncludes(out, "○ Broken.Proj -> ws-invalid (invalid:");
  assertStringIncludes(
    out,
    "Unsupported workspace config key 'featureFlags'",
  );
  assertStringIncludes(out, "root: /workspaces/My.Proj");
  assertStringIncludes(
    out,
    "config: /workspaces/Broken.Proj/.kato-workspace-config.yaml",
  );
});

// ─── Web view model ───────────────────────────────────────────────────────────

Deno.test("toStatusViewModel: sessions field populated from snapshot", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "a",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
    },
    {
      provider: "codex",
      sessionId: "b",
      stale: true,
      updatedAt: "2026-02-24T09:00:00.000Z",
    },
  ];
  const snapshot = makeSnapshot(sessions);
  const vm = toStatusViewModel(snapshot, { includeStale: false });
  assertEquals(vm.sessions.length, 1);
  assertEquals(vm.sessions[0].sessionId, "a");
  assertEquals(vm.sessionCount, 1);
});

Deno.test("toStatusViewModel: includeStale=true includes stale sessions", () => {
  const sessions: DaemonSessionStatus[] = [
    {
      provider: "claude",
      sessionId: "a",
      stale: false,
      updatedAt: "2026-02-24T10:00:00.000Z",
    },
    {
      provider: "codex",
      sessionId: "b",
      stale: true,
      updatedAt: "2026-02-24T09:00:00.000Z",
    },
  ];
  const snapshot = makeSnapshot(sessions);
  const vm = toStatusViewModel(snapshot, { includeStale: true });
  assertEquals(vm.sessions.length, 2);
});

Deno.test("toStatusViewModel: memory forwarded from snapshot", () => {
  const snapshot = makeSnapshot([]);
  const vm = toStatusViewModel(snapshot);
  assertEquals(vm.memory?.daemonMaxMemoryBytes, 200 * 1024 * 1024);
});

Deno.test("toStatusViewModel: sessions absent yields empty session count", () => {
  const snapshot: DaemonStatusSnapshot = {
    schemaVersion: 1,
    generatedAt: "2026-02-24T10:00:00.000Z",
    heartbeatAt: "2026-02-24T10:00:00.000Z",
    daemonRunning: true,
    providers: [{ provider: "claude", activeSessions: 3 }],
    recordings: { activeRecordings: 0, destinations: 0 },
  };
  const vm = toStatusViewModel(snapshot);
  assertEquals(vm.sessionCount, 0);
  assertEquals(vm.sessions.length, 0);
});
