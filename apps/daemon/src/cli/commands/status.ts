import type { DaemonSessionStatus, DaemonStatusSnapshot } from "@kato/shared";
import { filterSessionsForDisplay, isSessionStale } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

const LIVE_REFRESH_MS = 2_000;
const LIVE_SESSION_CAP = 5;
const DEFAULT_TERMINAL_WIDTH = 100;
const MIN_TERMINAL_WIDTH = 48;
const TWO_COLUMN_MIN_WIDTH = 96;
const COLUMN_GAP = 2;
const KEY_CTRL_C = 3;
const KEY_LOWER_Q = 113;
const KEY_UPPER_Q = 81;

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatRelativeTime(isoString: string | undefined, now: Date): string {
  if (!isoString) return "unknown";
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return "unknown";
  const diffSec = Math.floor((now.getTime() - ms) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) {
    const hours = Math.floor(diffSec / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function sanitizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return ".".repeat(width);
  return `${text.slice(0, width - 3)}...`;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return `${text}${" ".repeat(width - text.length)}`;
}

function formatPrefixedLine(
  prefix: string,
  content: string,
  width: number,
): string {
  const lineWidth = Math.max(width, MIN_TERMINAL_WIDTH);
  const maxContentWidth = Math.max(0, lineWidth - prefix.length);
  return `${prefix}${truncate(content, maxContentWidth)}`;
}

function resolveRenderWidth(terminalWidth?: number): number {
  if (
    terminalWidth !== undefined &&
    Number.isFinite(terminalWidth) &&
    terminalWidth > 0
  ) {
    return Math.max(MIN_TERMINAL_WIDTH, Math.floor(terminalWidth));
  }
  return DEFAULT_TERMINAL_WIDTH;
}

function resolveTerminalWidth(): number {
  try {
    const { columns } = Deno.consoleSize();
    return resolveRenderWidth(columns);
  } catch {
    return DEFAULT_TERMINAL_WIDTH;
  }
}

export function isLiveExitKey(keyByte: number): boolean {
  return keyByte === KEY_CTRL_C ||
    keyByte === KEY_LOWER_Q ||
    keyByte === KEY_UPPER_Q;
}

function buildMemoryLines(snapshot: DaemonStatusSnapshot): string[] {
  const mem = snapshot.memory;
  if (!mem) {
    return ["memory: unavailable"];
  }

  const budgetMb = Math.round(mem.daemonMaxMemoryBytes / (1024 * 1024));
  const rssMb = Math.round(mem.process.rss / (1024 * 1024));
  const snapshotBytes = formatBytes(mem.snapshots.estimatedBytes);
  const overBudget = mem.snapshots.overBudget ? "  ⚠ OVER BUDGET" : "";

  const line1 =
    `memory: ${rssMb} MB / ${budgetMb} MB${overBudget}  ·  snapshots ${snapshotBytes}`;
  const line2 =
    `sessions ${mem.snapshots.sessionCount}  ·  events ${mem.snapshots.eventCount}  ·  evictions ${mem.snapshots.evictionsTotal}`;
  return [line1, line2];
}

function summarizeRecordingsFromSessions(
  sessions: DaemonSessionStatus[] | undefined,
  fallback: DaemonStatusSnapshot["recordings"],
): DaemonStatusSnapshot["recordings"] {
  if (!sessions) return fallback;
  const activeSessionsWithRecording = sessions.filter((session) =>
    !session.stale && session.recording !== undefined
  );
  return {
    activeRecordings: activeSessionsWithRecording.length,
    destinations: new Set(
      activeSessionsWithRecording.map((session) => session.recording!.outputPath),
    ).size,
  };
}

function normalizeSnapshotForStatusDisplay(
  snapshot: DaemonStatusSnapshot,
  now: Date,
): DaemonStatusSnapshot {
  if (!snapshot.sessions) return snapshot;
  const normalizedSessions = snapshot.sessions.map((session) => ({
    ...session,
    stale: session.lastMessageAt
      ? isSessionStale(session.lastMessageAt, now)
      : true,
  }));
  return {
    ...snapshot,
    sessions: normalizedSessions,
    recordings: summarizeRecordingsFromSessions(
      normalizedSessions,
      snapshot.recordings,
    ),
  };
}

function renderTopSummarySection(
  snapshot: DaemonStatusSnapshot,
  opts: {
    daemonText: string;
    activeCount: number;
    staleCount: number;
    width: number;
    recordingSummary: DaemonStatusSnapshot["recordings"];
  },
): string[] {
  const { daemonText, activeCount, staleCount, width, recordingSummary } = opts;
  const memoryLines = buildMemoryLines(snapshot);
  const recordingLine =
    `recordings: ${recordingSummary.activeRecordings} active, ${staleCount} stale`;

  if (width < TWO_COLUMN_MIN_WIDTH) {
    return [
      truncate(memoryLines[0], width),
      truncate(memoryLines[1], width),
      truncate(recordingLine, width),
    ];
  }

  const leftLines = [
    `daemon: ${daemonText}`,
    `recordings: ${recordingSummary.activeRecordings} active`,
    `sessions: ${activeCount} active, ${staleCount} stale`,
  ];
  const rightLines = memoryLines;

  const leftWidth = Math.max(20, Math.floor((width - COLUMN_GAP) * 0.55));
  const rightWidth = Math.max(20, width - leftWidth - COLUMN_GAP);
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];

  for (let i = 0; i < rowCount; i += 1) {
    const left = leftLines[i] ?? "";
    const right = rightLines[i] ?? "";

    if (right.length === 0) {
      lines.push(truncate(left, width));
      continue;
    }

    const renderedLeft = padRight(truncate(left, leftWidth), leftWidth);
    const renderedRight = truncate(right, rightWidth);
    lines.push(
      truncate(
        `${renderedLeft}${" ".repeat(COLUMN_GAP)}${renderedRight}`,
        width,
      ),
    );
  }

  return lines;
}

function renderSessionRow(
  s: DaemonSessionStatus,
  now: Date,
  width: number,
): string[] {
  const marker = s.stale ? "○" : "●";
  const label = s.snippet
    ? `"${sanitizeInlineText(s.snippet)}"`
    : "(no user message)";
  const identity = s.sessionShortId ?? s.sessionId;
  const lastMessage = formatRelativeTime(s.lastMessageAt, now);
  const header =
    `${marker} ${s.provider}: ${label} (${identity})  ·  last message ${lastMessage}`;

  const lines: string[] = [truncate(header, width)];

  if (!s.recording) {
    lines.push(formatPrefixedLine("  ", "no active recordings", width));
    return lines;
  }

  const recMarker = s.stale ? "○" : "●";
  const recordingIdentity = s.recording.recordingShortId ??
    s.recording.recordingId ??
    identity;
  const recordingPrefix = `  ${recMarker} recording (${recordingIdentity}) -> `;
  lines.push(
    formatPrefixedLine(
      recordingPrefix,
      sanitizeInlineText(s.recording.outputPath),
      width,
    ),
  );

  const started = formatRelativeTime(s.recording.startedAt, now);
  const lastWrite = formatRelativeTime(s.recording.lastWriteAt, now);
  lines.push(
    formatPrefixedLine(
      "     ",
      `started ${started} · last write ${lastWrite}`,
      width,
    ),
  );

  return lines;
}

/**
 * Render the full status block as a string. Pure — no I/O.
 */
export function renderStatusText(
  snapshot: DaemonStatusSnapshot,
  opts: {
    showAll: boolean;
    sessionCap?: number;
    now: Date;
    stale: boolean;
    terminalWidth?: number;
  },
): string {
  const { showAll, now, stale } = opts;
  const sessionCap = opts.sessionCap ?? Infinity;
  const width = resolveRenderWidth(opts.terminalWidth);
  const divider = "─".repeat(width);

  const daemonText = snapshot.daemonRunning
    ? `running (pid: ${snapshot.daemonPid ?? "unknown"}${
      stale ? ", stale heartbeat" : ""
    })`
    : "stopped";

  const lines: string[] = [];

  // Sessions section
  const allSessions = snapshot.sessions ?? [];
  const activeCount = allSessions.filter((s) => !s.stale).length;
  const staleCount = allSessions.length - activeCount;
  const recordingSummary = summarizeRecordingsFromSessions(
    allSessions,
    snapshot.recordings,
  );
  const displaySessions = filterSessionsForDisplay(allSessions, {
    includeStale: showAll,
  }).slice(0, sessionCap);

  const sessionSummary = allSessions.length === 0
    ? ""
    : ` (${activeCount} active, ${staleCount} stale)`;

  const refreshedAt = now.toTimeString().slice(0, 8);
  lines.push(
    truncate(
      `kato  ·  daemon: ${daemonText}  ·  refreshed ${refreshedAt}`,
      width,
    ),
  );
  lines.push(divider);
  lines.push(
    ...renderTopSummarySection(snapshot, {
      daemonText,
      activeCount,
      staleCount,
      width,
      recordingSummary,
    }),
  );
  lines.push(divider);

  lines.push(`Sessions${sessionSummary}`);
  lines.push("");
  if (displaySessions.length === 0) {
    lines.push(
      showAll
        ? "  (none)"
        : `  (none active — run with --all to show ${staleCount} stale)`,
    );
  } else {
    for (const s of displaySessions) {
      lines.push(...renderSessionRow(s, now, width));
      lines.push("");
    }
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

function filterSnapshotForJson(
  snapshot: DaemonStatusSnapshot,
  showAll: boolean,
): DaemonStatusSnapshot {
  if (!snapshot.sessions) return snapshot;
  const sessions = filterSessionsForDisplay(snapshot.sessions, {
    includeStale: showAll,
  });
  return { ...snapshot, sessions };
}

// ─── Live mode ───────────────────────────────────────────────────────────────

async function runLiveMode(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    throw new Error(
      "--live requires an interactive terminal (stdin is not a TTY)",
    );
  }

  let shouldExit = false;

  const onSigint = () => {
    shouldExit = true;
  };
  Deno.addSignalListener("SIGINT", onSigint);

  Deno.stdin.setRaw(true);

  const stdinBuf = new Uint8Array(1);
  const readStdin = async () => {
    while (!shouldExit) {
      const n = await Deno.stdin.read(stdinBuf);
      if (n === null) break;
      // In raw mode Ctrl+C arrives as ETX (0x03), not SIGINT.
      if (isLiveExitKey(stdinBuf[0])) {
        shouldExit = true;
        break;
      }
    }
  };

  const stdinLoop = readStdin();

  try {
    while (!shouldExit) {
      const now = ctx.runtime.now();
      const snapshot = normalizeSnapshotForStatusDisplay(
        await ctx.statusStore.load(),
        now,
      );
      const stale = isStatusSnapshotStale(snapshot, now);
      const terminalWidth = resolveTerminalWidth();

      const body = renderStatusText(snapshot, {
        showAll: true,
        sessionCap: LIVE_SESSION_CAP,
        now,
        stale,
        terminalWidth,
      });

      // Clear screen and draw
      ctx.runtime.writeStdout("\x1B[2J\x1B[H");
      ctx.runtime.writeStdout(`${body}\n`);
      ctx.runtime.writeStdout(`\n${"─".repeat(terminalWidth)}\n`);
      ctx.runtime.writeStdout("Press q or Ctrl+C to exit\n");

      // Sleep with early exit check
      const start = Date.now();
      while (!shouldExit && Date.now() - start < LIVE_REFRESH_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    Deno.removeSignalListener("SIGINT", onSigint);
    Deno.stdin.setRaw(false);
  }

  await stdinLoop.catch(() => {});
  ctx.runtime.writeStdout("\n");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
  showAll: boolean,
  live: boolean,
): Promise<void> {
  if (live) {
    await runLiveMode(ctx);
    return;
  }

  const now = ctx.runtime.now();
  const snapshot = normalizeSnapshotForStatusDisplay(
    await ctx.statusStore.load(),
    now,
  );
  const stale = isStatusSnapshotStale(snapshot, now);

  await ctx.operationalLogger.info(
    "daemon.status",
    "Daemon status requested from CLI",
    {
      asJson,
      showAll,
      daemonRunning: snapshot.daemonRunning,
      daemonPid: snapshot.daemonPid,
      stale,
      statusPath: ctx.runtime.statusPath,
    },
  );
  await ctx.auditLogger.command("status", { asJson, showAll });

  if (asJson) {
    const filtered = filterSnapshotForJson(snapshot, showAll);
    ctx.runtime.writeStdout(`${JSON.stringify(filtered, null, 2)}\n`);
    return;
  }

  const terminalWidth = resolveTerminalWidth();
  ctx.runtime.writeStdout(
    renderStatusText(snapshot, { showAll, now, stale, terminalWidth }) + "\n",
  );
}
