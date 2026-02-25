import type { DaemonSessionStatus, DaemonStatusSnapshot } from "@kato/shared";
import { filterSessionsForDisplay } from "@kato/shared";
import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";

const LIVE_REFRESH_MS = 2_000;
const LIVE_SESSION_CAP = 5;
const DIVIDER = "─".repeat(49);

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatRelativeTime(isoString: string | undefined, now: Date): string {
  if (!isoString) return "unknown";
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return "unknown";
  const diffSec = Math.floor((now.getTime() - ms) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function renderSessionRow(s: DaemonSessionStatus, now: Date): string {
  const marker = s.stale ? "○" : "●";
  const label = s.snippet ? `"${s.snippet}"` : "(no user message)";
  const header = `${marker} ${s.provider}/${s.sessionId}: ${label}`;

  const lines: string[] = [header];

  if (s.recording) {
    lines.push(`  -> ${s.recording.outputPath}`);
    const started = formatRelativeTime(s.recording.startedAt, now);
    const lastWrite = formatRelativeTime(s.recording.lastWriteAt, now);
    lines.push(`  recording · started ${started} · last write ${lastWrite}`);
  } else if (s.stale) {
    const lastMsg = formatRelativeTime(s.lastMessageAt ?? s.updatedAt, now);
    lines.push(`  (stale) no active recording · last message ${lastMsg}`);
  } else {
    const lastMsg = formatRelativeTime(s.lastMessageAt ?? s.updatedAt, now);
    lines.push(`  no active recording · last message ${lastMsg}`);
  }

  return lines.join("\n");
}

function renderMemorySection(snapshot: DaemonStatusSnapshot): string | null {
  const mem = snapshot.memory;
  if (!mem) return null;

  const budgetMb = Math.round(mem.daemonMaxMemoryBytes / (1024 * 1024));
  const rssMb = Math.round(mem.process.rss / (1024 * 1024));
  const snapshotBytes = formatBytes(mem.snapshots.estimatedBytes);
  const overBudget = mem.snapshots.overBudget ? "  ⚠ OVER BUDGET" : "";

  const line1 = `  rss ${rssMb} MB / ${budgetMb} MB budget  ·  snapshots ${snapshotBytes}${overBudget}`;
  const line2 = `  sessions ${mem.snapshots.sessionCount}  ·  events ${mem.snapshots.eventCount}  ·  evictions ${mem.snapshots.evictionsTotal}`;
  return [line1, line2].join("\n");
}

/**
 * Render the full status block as a string. Pure — no I/O.
 */
export function renderStatusText(
  snapshot: DaemonStatusSnapshot,
  opts: { showAll: boolean; sessionCap?: number; now: Date; stale: boolean },
): string {
  const { showAll, now, stale } = opts;
  const sessionCap = opts.sessionCap ?? Infinity;

  const daemonText = snapshot.daemonRunning
    ? `running (pid: ${snapshot.daemonPid ?? "unknown"}${
      stale ? ", stale heartbeat" : ""
    })`
    : "stopped";

  const lines: string[] = [];
  lines.push(`daemon: ${daemonText}`);
  lines.push(`schemaVersion: ${snapshot.schemaVersion}`);
  lines.push(`generatedAt: ${snapshot.generatedAt}`);
  lines.push(`heartbeatAt: ${snapshot.heartbeatAt}`);

  // Sessions section
  const allSessions = snapshot.sessions ?? [];
  const activeCount = allSessions.filter((s) => !s.stale).length;
  const staleCount = allSessions.length - activeCount;
  const displaySessions = filterSessionsForDisplay(allSessions, {
    includeStale: showAll,
  }).slice(0, sessionCap);

  const sessionSummary = allSessions.length === 0
    ? ""
    : ` (${activeCount} active, ${staleCount} stale)`;
  lines.push("");
  lines.push(`Sessions${sessionSummary}:`);
  if (displaySessions.length === 0) {
    lines.push(
      showAll
        ? "  (none)"
        : `  (none active — run with --all to show ${staleCount} stale)`,
    );
  } else {
    for (const s of displaySessions) {
      lines.push(renderSessionRow(s, now));
    }
  }

  // Memory section
  const memSection = renderMemorySection(snapshot);
  if (memSection) {
    lines.push("");
    lines.push("Memory:");
    lines.push(memSection);
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

  Deno.addSignalListener("SIGINT", () => {
    shouldExit = true;
  });

  Deno.stdin.setRaw(true);

  const stdinBuf = new Uint8Array(1);
  const readStdin = async () => {
    while (!shouldExit) {
      const n = await Deno.stdin.read(stdinBuf);
      if (n === null) break;
      // q or Q
      if (stdinBuf[0] === 113 || stdinBuf[0] === 81) {
        shouldExit = true;
        break;
      }
    }
  };

  const stdinLoop = readStdin();

  try {
    while (!shouldExit) {
      const now = ctx.runtime.now();
      const snapshot: DaemonStatusSnapshot = await ctx.statusStore.load();
      const stale = isStatusSnapshotStale(snapshot, now);

      const refreshedAt = now.toTimeString().slice(0, 8);
      const header = `kato  ·  ${snapshot.daemonRunning ? "daemon running" : "daemon stopped"}  ·  refreshed ${refreshedAt}`;

      const body = renderStatusText(snapshot, {
        showAll: true,
        sessionCap: LIVE_SESSION_CAP,
        now,
        stale,
      });

      // Clear screen and draw
      ctx.runtime.writeStdout("\x1B[2J\x1B[H");
      ctx.runtime.writeStdout(`${header}\n`);
      ctx.runtime.writeStdout(`${DIVIDER}\n\n`);
      ctx.runtime.writeStdout(`${body}\n`);
      ctx.runtime.writeStdout(`\n${DIVIDER}\n`);
      ctx.runtime.writeStdout("Press q or Ctrl+C to exit\n");

      // Sleep with early exit check
      const start = Date.now();
      while (!shouldExit && Date.now() - start < LIVE_REFRESH_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
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
  const snapshot: DaemonStatusSnapshot = await ctx.statusStore.load();
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

  ctx.runtime.writeStdout(
    renderStatusText(snapshot, { showAll, now, stale }) + "\n",
  );
}
