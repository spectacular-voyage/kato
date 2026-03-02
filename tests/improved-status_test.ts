import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { DaemonSessionStatus, DaemonStatusSnapshot } from "@kato/shared";
import { CliUsageError, parseDaemonCliArgs } from "../apps/daemon/src/mod.ts";
import {
  isLiveExitKey,
  renderStatusText,
} from "../apps/daemon/src/cli/commands/status.ts";
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
  assertEquals(isLiveExitKey(10), false);
  assertEquals(isLiveExitKey(32), false);
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
  assertStringIncludes(out, "kato  ·  daemon:");
  assertStringIncludes(out, "Sessions");
  assertStringIncludes(out, "(none");
});

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
  });
  assertStringIncludes(out, "memory:");
  assertStringIncludes(out, "MB /");
  assertStringIncludes(out, "snapshots");
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
  assertStringIncludes(out, "memory:");
  assertStringIncludes(out, "recordings:");
  assertStringIncludes(out, "stale sessions");
});

Deno.test("renderStatusText: wide width keeps two-column summary", () => {
  const out = renderStatusText(makeSnapshot([]), {
    showAll: true,
    now: NOW,
    stale: false,
    terminalWidth: 120,
  });
  assertStringIncludes(out, "daemon: running");
  assertStringIncludes(out, "memory:");
  assert(
    out.split("\n").some((line) =>
      line.includes("daemon: running") && line.includes("memory:")
    ),
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
