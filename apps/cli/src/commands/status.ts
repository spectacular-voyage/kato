import type {
  DaemonSessionStatus,
  DaemonStatusSnapshot,
  RecordingActivitySummary,
} from "@kato/shared";
import {
  filterSessionsForDisplay,
  isSessionStale,
  summarizeRecordingActivity,
} from "@kato/shared";
import { join } from "@std/path";
import type { DaemonCliCommandContext } from "./context.ts";
import { isProcessAlive, isStatusSnapshotStale } from "@kato/runtime";
import { CLI_APP_VERSION } from "../version.ts";
import {
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
} from "@kato/runtime";
import { resolveWorkspaceRegistryStore } from "./workspace_shared.ts";
import {
  loadSuppressedRecentErrorKeys,
  resolveStatusErrorCursorPath,
  saveSuppressedRecentErrorKeys,
} from "./status_error_cursor.ts";
import {
  loadWorkspaceStatusSummary,
  type WorkspaceStatusSummary,
} from "./status_workspace.ts";
export type {
  WorkspaceStatusRow,
  WorkspaceStatusSummary,
} from "./status_workspace.ts";

const LIVE_REFRESH_MS = 2_000;
const LIVE_SESSION_CAP = 5;
const DEFAULT_TERMINAL_WIDTH = 100;
const MIN_TERMINAL_WIDTH = 48;
const TWO_COLUMN_MIN_WIDTH = 96;
const COLUMN_GAP = 2;
const MAX_WORKSPACE_ALIAS_DISPLAY_LENGTH = 80;
const REDACTED_WORKSPACE_ALIAS = "<redacted-alias>";
const RECENT_ERRORS_LIMIT = 8;
const RECENT_ERRORS_TAIL_BYTES = 2 * 1024 * 1024;
const OPERATIONAL_LOG_FILENAME = "operational.jsonl";
const SECURITY_AUDIT_LOG_FILENAME = "security-audit.jsonl";
const KEY_CTRL_C = 3;
const KEY_LOWER_Q = 113;
const KEY_UPPER_Q = 81;
const KEY_LOWER_F = 102;
const KEY_UPPER_F = 70;
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const ANSI_RESET = `${ANSI_ESCAPE}[0m`;
const ANSI_GREEN = `${ANSI_ESCAPE}[32m`;
const ANSI_AMBER = `${ANSI_ESCAPE}[38;5;178m`;
const ANSI_RED = `${ANSI_ESCAPE}[31m`;
const ANSI_OSC_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\][^\\u0007]*(?:\\u0007|${ANSI_ESCAPE}\\\\)`,
  "g",
);
const ANSI_CSI_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export interface StatusRecentError {
  timestamp: string;
  level: "warn" | "error";
  channel: "operational" | "security-audit";
  event: string;
  message: string;
  source?: "log" | "workspace";
  scope?: "daemon" | "web" | "workspace";
}

export interface StatusWebState {
  configured: boolean;
  running: boolean;
  stale: boolean;
  state: "running" | "stopped" | "stale" | "unconfigured";
  hostname?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  url?: string;
  version?: string;
}

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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalTimestamp(isoString: string | undefined): string {
  if (!isoString) return "unknown";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${
    pad2(date.getDate())
  } ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function sanitizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function colorizeText(
  text: string,
  tone: "green" | "amber" | "red",
  enabled: boolean,
): string {
  if (!enabled) {
    return text;
  }
  const color = tone === "green"
    ? ANSI_GREEN
    : tone === "amber"
    ? ANSI_AMBER
    : ANSI_RED;
  return `${color}${text}${ANSI_RESET}`;
}

function formatStateCount(
  count: number,
  label: "active" | "stale" | "inactive" | "invalid",
  colorize: boolean,
): string {
  switch (label) {
    case "active":
      return colorizeText(`${count} active`, "green", colorize);
    case "stale":
      return colorizeText(`${count} idle`, "amber", colorize);
    case "invalid":
      return colorizeText(`${count} invalid`, "red", colorize);
    case "inactive":
      return `${count} off`;
  }
}

function formatStatusToken(
  text: string,
  tone: "green" | "amber" | "red" | "plain",
  colorize: boolean,
): string {
  if (tone === "plain") {
    return text;
  }
  return colorizeText(text, tone, colorize);
}

function sanitizeWorkspaceAlias(alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  const withoutAnsi = alias
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "");
  let withoutControl = "";
  for (const char of withoutAnsi) {
    const code = char.charCodeAt(0);
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    withoutControl += isControl ? " " : char;
  }
  const normalized = sanitizeInlineText(withoutControl);
  if (normalized.length === 0) return undefined;
  return normalized.slice(0, MAX_WORKSPACE_ALIAS_DISPLAY_LENGTH);
}

function resolveDisplayWorkspaceAlias(alias: string | undefined): string {
  return sanitizeWorkspaceAlias(alias) ?? REDACTED_WORKSPACE_ALIAS;
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

function shouldColorizeStatusOutput(): boolean {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

async function readTailText(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(filePath, { read: true });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw error;
  }

  try {
    const stat = await file.stat();
    if (stat.size <= 0) {
      return "";
    }
    const start = Math.max(0, stat.size - maxBytes);
    await file.seek(start, Deno.SeekMode.Start);

    const bytes = new Uint8Array(Number(stat.size - start));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes.subarray(offset));
      if (read === null) {
        break;
      }
      offset += read;
    }
    let text = new TextDecoder().decode(bytes.subarray(0, offset));
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    return text;
  } finally {
    file.close();
  }
}

function parseStatusRecentError(
  value: unknown,
  scope: StatusRecentError["scope"] = "daemon",
): StatusRecentError | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const level = record["level"];
  if (level !== "warn" && level !== "error") {
    return undefined;
  }
  const channel = record["channel"];
  if (channel !== "operational" && channel !== "security-audit") {
    return undefined;
  }
  const timestamp = record["timestamp"];
  if (
    typeof timestamp !== "string" ||
    timestamp.length === 0 ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    return undefined;
  }
  const event = record["event"];
  const message = record["message"];
  return {
    timestamp,
    level,
    channel,
    event: typeof event === "string" && event.length > 0 ? event : "unknown",
    message: typeof message === "string" && message.trim().length > 0
      ? sanitizeInlineText(message)
      : "no message",
    source: "log",
    scope,
  };
}

async function loadRecentErrorsFromLog(
  filePath: string,
  scope: StatusRecentError["scope"] = "daemon",
): Promise<StatusRecentError[]> {
  const tail = await readTailText(filePath, RECENT_ERRORS_TAIL_BYTES);
  if (!tail) {
    return [];
  }
  const errors: StatusRecentError[] = [];
  const lines = tail.split(/\r\n?|\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const errorRecord = parseStatusRecentError(parsed, scope);
      if (!errorRecord) {
        continue;
      }
      errors.push(errorRecord);
    } catch {
      continue;
    }
  }
  return errors;
}

async function loadRecentStatusErrors(
  ctx: DaemonCliCommandContext,
): Promise<StatusRecentError[]> {
  const katoDir = ctx.runtimeConfig.katoDir ?? ctx.runtime.runtimeDir;
  const operationalPath = join(
    ctx.runtime.runtimeDir,
    "logs",
    OPERATIONAL_LOG_FILENAME,
  );
  const securityAuditPath = join(
    ctx.runtime.runtimeDir,
    "logs",
    SECURITY_AUDIT_LOG_FILENAME,
  );
  const webOperationalPath = join(
    katoDir,
    "web",
    "logs",
    OPERATIONAL_LOG_FILENAME,
  );
  const webSecurityAuditPath = join(
    katoDir,
    "web",
    "logs",
    SECURITY_AUDIT_LOG_FILENAME,
  );
  const [operational, securityAudit, webOperational, webSecurityAudit] =
    await Promise.all([
      loadRecentErrorsFromLog(operationalPath, "daemon"),
      loadRecentErrorsFromLog(securityAuditPath, "daemon"),
      loadRecentErrorsFromLog(webOperationalPath, "web"),
      loadRecentErrorsFromLog(webSecurityAuditPath, "web"),
    ]);
  return [
    ...operational,
    ...securityAudit,
    ...webOperational,
    ...webSecurityAudit,
  ]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, RECENT_ERRORS_LIMIT);
}

async function loadStatusWebState(
  ctx: DaemonCliCommandContext,
): Promise<StatusWebState> {
  const stored = await ctx.webStatusStore.load();
  const alive = stored.running && isProcessAlive(stored.pid);
  const stale = stored.running && !alive;
  const configured = ctx.webConfig !== undefined;
  const url = ctx.webConfig
    ? `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`
    : stored.url;
  const state = alive
    ? "running"
    : stale
    ? "stale"
    : configured
    ? "stopped"
    : "unconfigured";

  return {
    configured,
    running: alive,
    stale,
    state,
    hostname: ctx.webConfig?.hostname ?? stored.hostname,
    port: ctx.webConfig?.port ?? stored.port,
    pid: stored.pid,
    startedAt: stored.startedAt,
    heartbeatAt: stored.heartbeatAt,
    url,
    version: stored.version,
  };
}

function renderWebStatusText(
  webStatus: StatusWebState | undefined,
  colorize: boolean = false,
): string | undefined {
  if (!webStatus) {
    return undefined;
  }
  if (webStatus.state === "unconfigured") {
    return "unconfigured";
  }
  if (webStatus.state === "running") {
    return `${formatStatusToken("running", "green", colorize)} (${
      webStatus.url ?? "url unavailable"
    }, pid ${webStatus.pid ?? "unknown"})`;
  }
  if (webStatus.state === "stale") {
    return `${formatStatusToken("stale status", "amber", colorize)} (${
      webStatus.url ?? "url unavailable"
    }, pid ${webStatus.pid ?? "unknown"}, heartbeat ${
      formatLocalTimestamp(webStatus.heartbeatAt)
    })`;
  }
  return `stopped (${webStatus.url ?? "url unavailable"})`;
}

function renderWebHeaderLine(
  webStatus: StatusWebState | undefined,
  colorize: boolean = false,
): string | undefined {
  const webText = renderWebStatusText(webStatus, colorize);
  if (!webText) {
    return undefined;
  }
  const version = webStatus?.version ?? CLI_APP_VERSION;
  return `kato web (v${version}): ${webText}`;
}

function deriveWorkspaceStatusErrors(
  workspaceStatus: WorkspaceStatusSummary | undefined,
  now: Date,
): StatusRecentError[] {
  if (!workspaceStatus) {
    return [];
  }

  const timestamp = now.toISOString();
  const errors: StatusRecentError[] = [];

  if (workspaceStatus.unavailableReason) {
    errors.push({
      timestamp,
      level: "error",
      channel: "operational",
      event: "workspace.status.unavailable",
      message: sanitizeInlineText(workspaceStatus.unavailableReason),
      source: "workspace",
      scope: "workspace",
    });
    return errors;
  }

  for (const row of workspaceStatus.rows) {
    if (row.valid) {
      continue;
    }
    const reason = sanitizeInlineText(
      row.invalidReason ?? "invalid workspace configuration",
    );
    const alias = resolveDisplayWorkspaceAlias(row.alias);
    const reasonLower = reason.toLowerCase();
    const event = reasonLower.includes("permission denied")
      ? "workspace.config.permission_denied"
      : "workspace.config.invalid";
    errors.push({
      timestamp,
      level: "error",
      channel: "operational",
      event,
      message: `${alias} (${row.workspaceId}): ${reason}`,
      source: "workspace",
      scope: "workspace",
    });
  }

  return errors;
}

export function isLiveExitKey(keyByte: number): boolean {
  return keyByte === KEY_CTRL_C ||
    keyByte === KEY_LOWER_Q ||
    keyByte === KEY_UPPER_Q;
}

export function isLiveFlushKey(keyByte: number): boolean {
  return keyByte === KEY_LOWER_F || keyByte === KEY_UPPER_F;
}

export function getStatusRecentErrorKey(error: StatusRecentError): string {
  const event = sanitizeInlineText(error.event);
  const message = sanitizeInlineText(error.message);
  const scopePrefix = error.scope === "web" ? "web|" : "";
  const base =
    `${scopePrefix}${error.level}|${error.channel}|${event}|${message}`;
  if (error.source === "workspace") {
    // Workspace-derived rows are synthetic "current state" errors, so keep
    // the key stable across refreshes to suppress until the state changes.
    return `workspace|${base}`;
  }
  return `log|${error.timestamp}|${base}`;
}

function getRecentErrorDedupeKey(error: StatusRecentError): string {
  const event = sanitizeInlineText(error.event);
  const message = sanitizeInlineText(error.message);
  const scopePrefix = error.scope === "web" ? "web|" : "";
  return `${scopePrefix}${error.level}|${error.channel}|${event}|${message}`;
}

function dedupeRecentErrors(errors: StatusRecentError[]): StatusRecentError[] {
  const seen = new Set<string>();
  const deduped: StatusRecentError[] = [];
  for (const error of errors) {
    const key = getRecentErrorDedupeKey(error);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(error);
  }
  return deduped;
}

function collectRecentErrors(
  now: Date,
  workspaceStatus: WorkspaceStatusSummary | undefined,
  logRecentErrors: StatusRecentError[] | undefined,
): StatusRecentError[] {
  const sortedLogErrors = [...(logRecentErrors ?? [])]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const reservedLogSlots = Math.min(
    sortedLogErrors.length,
    Math.max(1, Math.floor(RECENT_ERRORS_LIMIT * 0.3)),
  );
  const reservedLogErrors = sortedLogErrors.slice(0, reservedLogSlots);
  const remainingCandidates = [
    ...deriveWorkspaceStatusErrors(workspaceStatus, now),
    ...sortedLogErrors.slice(reservedLogSlots),
  ];
  const dedupedCombined = dedupeRecentErrors([
    ...reservedLogErrors,
    ...remainingCandidates,
  ]);
  let limited = dedupedCombined
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, RECENT_ERRORS_LIMIT);
  if (reservedLogErrors.length === 0 || limited.length === 0) {
    return limited;
  }
  const reservedKeys = new Set(
    reservedLogErrors.map((error) => getRecentErrorDedupeKey(error)),
  );
  const hasReservedError = limited.some((error) =>
    reservedKeys.has(getRecentErrorDedupeKey(error))
  );
  if (hasReservedError) {
    return limited;
  }
  const fallbackReservedError = dedupedCombined.find((error) =>
    reservedKeys.has(getRecentErrorDedupeKey(error))
  );
  if (!fallbackReservedError) {
    return limited;
  }
  limited = [
    ...limited.slice(0, Math.max(RECENT_ERRORS_LIMIT - 1, 0)),
    fallbackReservedError,
  ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return limited;
}

function reconcileSuppressedRecentErrorKeys(
  suppressedRecentErrorKeys: Set<string>,
  currentRecentErrorKeys: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const key of [...suppressedRecentErrorKeys]) {
    if (currentRecentErrorKeys.has(key)) {
      continue;
    }
    suppressedRecentErrorKeys.delete(key);
    changed = true;
  }
  return changed;
}

async function persistSuppressedRecentErrorKeysBestEffort(
  cursorPath: string,
  suppressedRecentErrorKeys: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  try {
    await saveSuppressedRecentErrorKeys(
      cursorPath,
      suppressedRecentErrorKeys,
      now,
    );
  } catch {
    // Best-effort persistence: keep live output responsive even if cursor
    // writes fail due to transient filesystem issues.
  }
}

function buildMemoryLines(snapshot: DaemonStatusSnapshot): string[] {
  const mem = snapshot.memory;
  if (!mem) {
    return [
      "daemon memory: unavailable",
      "session data size: unavailable",
    ];
  }

  const budgetMb = Math.round(mem.daemonMaxMemoryBytes / (1024 * 1024));
  const rssMb = Math.round(mem.process.rss / (1024 * 1024));
  const snapshotBytes = formatBytes(mem.snapshots.estimatedBytes);
  const overBudget = mem.snapshots.overBudget ? "  ⚠ OVER BUDGET" : "";

  const line1 = `daemon memory: ${rssMb} MB / ${budgetMb} MB${overBudget}`;
  const line2 = `session data size: ${snapshotBytes}`;
  const line3 =
    `events ${mem.snapshots.eventCount}  ·  evictions ${mem.snapshots.evictionsTotal}`;
  return [line1, line2, line3];
}

function normalizeSnapshotForStatusDisplay(
  snapshot: DaemonStatusSnapshot,
  now: Date,
): DaemonStatusSnapshot {
  if (!snapshot.sessions) return snapshot;
  const normalizedSessions = snapshot.sessions.map((session) => ({
    ...session,
    stale: session.lastEventAt
      ? isSessionStale(session.lastEventAt, now)
      : typeof session.stale === "boolean"
      ? session.stale
      : true,
  }));
  const recordingActivity = summarizeRecordingActivity(
    normalizedSessions,
    snapshot.recordings,
  );
  return {
    ...snapshot,
    sessions: normalizedSessions,
    recordings: {
      activeRecordings: recordingActivity.activeRecordings,
      destinations: recordingActivity.destinations,
    },
  };
}

function renderTopSummarySection(
  snapshot: DaemonStatusSnapshot,
  opts: {
    activeCount: number;
    staleCount: number;
    width: number;
    recordingActivity: RecordingActivitySummary;
    colorize?: boolean;
  },
): string[] {
  const { activeCount, staleCount, width, recordingActivity } = opts;
  const colorize = opts.colorize ?? false;
  const memoryLines = buildMemoryLines(snapshot);
  const recordingLine = `recordings: ${
    formatStateCount(recordingActivity.activeRecordings, "active", colorize)
  }, ${
    formatStateCount(
      recordingActivity.inactiveRecordings,
      "inactive",
      colorize,
    )
  }`;

  if (width < TWO_COLUMN_MIN_WIDTH) {
    return [
      truncate(memoryLines[0], width),
      truncate(memoryLines[1], width),
      truncate(recordingLine, width),
    ];
  }

  const leftLines = [
    recordingLine,
    `sessions: ${formatStateCount(activeCount, "active", colorize)}, ${
      formatStateCount(staleCount, "stale", colorize)
    }`,
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
  colorize: boolean = false,
): string[] {
  const marker = s.stale
    ? colorizeText("○", "amber", colorize)
    : colorizeText("●", "green", colorize);
  const label = s.snippet
    ? `"${sanitizeInlineText(s.snippet)}"`
    : "(no user message)";
  const identity = s.sessionShortId ?? s.sessionId;
  const updatedAt = formatLocalTimestamp(s.updatedAt);
  const headerParts = [
    `${marker} ${s.provider}: ${label} (${identity})`,
    `updated ${updatedAt}`,
  ];
  if (s.lastEventAt) {
    headerParts.push(`last event ${formatRelativeTime(s.lastEventAt, now)}`);
  }
  const header = headerParts.join("  ·  ");

  const lines: string[] = [truncate(header, width)];

  if (!s.recordings || s.recordings.length === 0) {
    lines.push(formatPrefixedLine("  ", "no active recordings", width));
    return lines;
  }

  const recMarker = s.stale
    ? colorizeText("○", "amber", colorize)
    : colorizeText("●", "green", colorize);
  for (const recording of s.recordings) {
    const recordingIdentity = recording.recordingShortId ??
      recording.recordingId ??
      identity;
    const started = formatLocalTimestamp(recording.startedAt);
    const lastWrite = formatRelativeTime(recording.lastWriteAt, now);
    const restarted = recording.restartedAt
      ? ` · re-started ${formatRelativeTime(recording.restartedAt, now)}`
      : "";
    const workspaceLabel = sanitizeWorkspaceAlias(recording.workspaceAlias);
    const recordingHeader = workspaceLabel && workspaceLabel.length > 0
      ? `started: ${started}${restarted} · last write ${lastWrite} · workspace: ${workspaceLabel}`
      : `started: ${started}${restarted} · last write ${lastWrite}`;
    lines.push(
      formatPrefixedLine(
        "  ",
        `${recMarker} recording (${recordingIdentity}) ${recordingHeader}`,
        width,
      ),
    );
    lines.push(
      formatPrefixedLine(
        "   -> ",
        sanitizeInlineText(recording.outputPath),
        width,
      ),
    );
  }

  return lines;
}

function renderWorkspaceSummaryLine(
  workspaceStatus: WorkspaceStatusSummary | undefined,
  colorize: boolean = false,
): string | undefined {
  if (!workspaceStatus) {
    return undefined;
  }
  if (workspaceStatus.unavailableReason) {
    return `workspaces: unavailable (${workspaceStatus.unavailableReason})`;
  }
  return `workspaces: ${
    formatStateCount(workspaceStatus.activeCount, "active", colorize)
  }, ${formatStateCount(workspaceStatus.invalidCount, "invalid", colorize)}`;
}

function renderWorkspaceSection(
  workspaceStatus: WorkspaceStatusSummary,
  width: number,
  colorize: boolean = false,
): string[] {
  if (workspaceStatus.unavailableReason) {
    return [
      "Workspaces",
      "",
      formatPrefixedLine(
        "  ",
        `unavailable: ${workspaceStatus.unavailableReason}`,
        width,
      ),
    ];
  }

  const lines: string[] = [
    `Workspaces (${
      formatStateCount(workspaceStatus.activeCount, "active", colorize)
    }, ${formatStateCount(workspaceStatus.invalidCount, "invalid", colorize)})`,
    "",
  ];

  if (workspaceStatus.rows.length === 0) {
    lines.push("  (none registered)");
    return lines;
  }

  for (const row of workspaceStatus.rows) {
    const marker = row.valid
      ? colorizeText("●", "green", colorize)
      : colorizeText("○", "red", colorize);
    const alias = resolveDisplayWorkspaceAlias(row.alias);
    const statusLabel = row.valid
      ? formatStatusToken("valid", "green", colorize)
      : `${formatStatusToken("invalid", "red", colorize)}: ${
        row.invalidReason ?? "unknown error"
      }`;
    lines.push(
      formatPrefixedLine(
        `  ${marker} `,
        `${alias} -> ${row.workspaceId} (${statusLabel})`,
        width,
      ),
    );
    lines.push(
      formatPrefixedLine(
        "     ",
        `root: ${sanitizeInlineText(row.workspaceRoot)}`,
        width,
      ),
    );
    lines.push(
      formatPrefixedLine(
        "     ",
        `config: ${sanitizeInlineText(row.configPath)}`,
        width,
      ),
    );
    lines.push("");
  }

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
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
    workspaceStatus?: WorkspaceStatusSummary;
    webStatus?: StatusWebState;
    showWorkspaceDetails?: boolean;
    recentErrors?: StatusRecentError[];
    suppressedRecentErrorKeys?: ReadonlySet<string>;
    colorize?: boolean;
  },
): string {
  const { showAll, now, stale } = opts;
  const sessionCap = opts.sessionCap ?? Infinity;
  const width = resolveRenderWidth(opts.terminalWidth);
  const colorize = opts.colorize ?? false;
  const divider = "─".repeat(width);
  const workspaceSummary = renderWorkspaceSummaryLine(
    opts.workspaceStatus,
    colorize,
  );
  const webHeaderLine = renderWebHeaderLine(opts.webStatus, colorize);
  const recentErrors = collectRecentErrors(
    now,
    opts.workspaceStatus,
    opts.recentErrors,
  );
  const visibleRecentErrors = opts.suppressedRecentErrorKeys
    ? recentErrors.filter((error) =>
      !opts.suppressedRecentErrorKeys?.has(getStatusRecentErrorKey(error))
    )
    : recentErrors;

  const daemonText = snapshot.daemonRunning
    ? `running (pid: ${snapshot.daemonPid ?? "unknown"}${
      stale ? ", stale heartbeat" : ""
    })`
    : "stopped";

  const lines: string[] = [];

  // Sessions section
  const sessionsLoading = snapshot.sessions === undefined &&
    snapshot.daemonRunning;
  const allSessions = snapshot.sessions ?? [];
  const activeCount = allSessions.filter((s) => !s.stale).length;
  const staleCount = allSessions.length - activeCount;
  const recordingActivity = summarizeRecordingActivity(
    allSessions,
    snapshot.recordings,
  );
  const displaySessions = filterSessionsForDisplay(allSessions, {
    includeStale: showAll,
  }).slice(0, sessionCap);

  const sessionSummary = allSessions.length === 0
    ? ""
    : ` (${activeCount} active, ${staleCount} idle)`;

  const refreshedAt = now.toTimeString().slice(0, 8);
  const daemonVersion = snapshot.daemonVersion ?? "unknown";
  lines.push(
    truncate(
      `kato CLI (v${CLI_APP_VERSION})  ·  refreshed ${refreshedAt}`,
      width,
    ),
  );
  lines.push(
    truncate(`kato daemon (v${daemonVersion}): ${daemonText}`, width),
  );
  if (webHeaderLine) {
    lines.push(truncate(webHeaderLine, width));
  }
  lines.push(divider);
  lines.push(
    ...renderTopSummarySection(snapshot, {
      activeCount,
      staleCount,
      width,
      recordingActivity,
      colorize,
    }),
  );
  if (workspaceSummary) {
    lines.push(truncate(workspaceSummary, width));
  }
  lines.push(divider);
  if (opts.showWorkspaceDetails && opts.workspaceStatus) {
    lines.push(
      ...renderWorkspaceSection(opts.workspaceStatus, width, colorize),
    );
    lines.push(divider);
  }

  lines.push(`Recent Errors (${visibleRecentErrors.length})`);
  if (visibleRecentErrors.length > 0) {
    lines.push("");
    for (const recentError of visibleRecentErrors) {
      const scopePrefix = recentError.scope === "web" ? "web " : "";
      const channel = recentError.channel === "security-audit"
        ? "audit"
        : "operational";
      const level = recentError.level.toUpperCase();
      const renderedLevel = recentError.level === "error"
        ? colorizeText(level, "red", colorize)
        : colorizeText(level, "amber", colorize);
      const detail = `[${
        formatLocalTimestamp(recentError.timestamp)
      }] ${renderedLevel} ${scopePrefix}${channel} ${
        sanitizeInlineText(recentError.event)
      } · ${sanitizeInlineText(recentError.message)}`;
      lines.push(formatPrefixedLine("  ", detail, width));
    }
  }
  lines.push(divider);

  lines.push(`Sessions${sessionSummary}`);
  lines.push("");
  if (displaySessions.length === 0) {
    lines.push(
      sessionsLoading
        ? "  (loading...)"
        : !snapshot.daemonRunning
        ? "  (daemon not running)"
        : showAll
        ? "  (none)"
        : `  (none active — run with --all to show ${staleCount} idle)`,
    );
  } else {
    for (const s of displaySessions) {
      lines.push(...renderSessionRow(s, now, width, colorize));
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
  let flushRecentErrorsRequested = false;
  const statusErrorCursorPath = resolveStatusErrorCursorPath(
    ctx.runtime.runtimeDir,
  );
  const suppressedRecentErrorKeys = await loadSuppressedRecentErrorKeys(
    statusErrorCursorPath,
  );

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
      if (isLiveFlushKey(stdinBuf[0])) {
        flushRecentErrorsRequested = true;
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
      const [workspaceStatus, recentErrors, webStatus] = await Promise.all([
        loadWorkspaceStatusSummary(
          () => resolveWorkspaceRegistryStore(ctx).load(),
          {
            loadWorkspaceConfigOverrides,
            readWorkspaceConfigWorkspaceId,
          },
        ),
        loadRecentStatusErrors(ctx),
        loadStatusWebState(ctx),
      ]);
      const stale = isStatusSnapshotStale(snapshot, now);
      const terminalWidth = resolveTerminalWidth();
      const currentRecentErrorKeys = new Set(
        collectRecentErrors(now, workspaceStatus, recentErrors).map((error) =>
          getStatusRecentErrorKey(error)
        ),
      );
      let shouldPersistSuppressedKeys = false;
      if (flushRecentErrorsRequested) {
        suppressedRecentErrorKeys.clear();
        for (const key of currentRecentErrorKeys) {
          suppressedRecentErrorKeys.add(key);
        }
        flushRecentErrorsRequested = false;
        shouldPersistSuppressedKeys = true;
      } else if (suppressedRecentErrorKeys.size > 0) {
        shouldPersistSuppressedKeys = reconcileSuppressedRecentErrorKeys(
          suppressedRecentErrorKeys,
          currentRecentErrorKeys,
        );
      }
      if (shouldPersistSuppressedKeys) {
        await persistSuppressedRecentErrorKeysBestEffort(
          statusErrorCursorPath,
          suppressedRecentErrorKeys,
          now,
        );
      }

      const body = renderStatusText(snapshot, {
        showAll: true,
        sessionCap: LIVE_SESSION_CAP,
        now,
        stale,
        terminalWidth,
        workspaceStatus,
        webStatus,
        recentErrors,
        suppressedRecentErrorKeys,
        colorize: shouldColorizeStatusOutput(),
      });

      // Clear screen and draw
      ctx.runtime.writeStdout("\x1B[2J\x1B[H");
      ctx.runtime.writeStdout(`${body}\n`);
      ctx.runtime.writeStdout(`\n${"─".repeat(terminalWidth)}\n`);
      ctx.runtime.writeStdout(
        "Press q or Ctrl+C to exit · press f to flush errors (persisted)\n",
      );

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
  const statusErrorCursorPath = resolveStatusErrorCursorPath(
    ctx.runtime.runtimeDir,
  );
  const workspaceStatus = asJson ? undefined : await loadWorkspaceStatusSummary(
    () => resolveWorkspaceRegistryStore(ctx).load(),
    {
      loadWorkspaceConfigOverrides,
      readWorkspaceConfigWorkspaceId,
    },
  );
  const webStatus = await loadStatusWebState(ctx);
  const stale = isStatusSnapshotStale(snapshot, now);
  const recentErrors = asJson ? undefined : await loadRecentStatusErrors(ctx);
  const suppressedRecentErrorKeys = asJson
    ? undefined
    : await loadSuppressedRecentErrorKeys(statusErrorCursorPath);
  if (
    !asJson &&
    suppressedRecentErrorKeys &&
    suppressedRecentErrorKeys.size > 0
  ) {
    const currentRecentErrorKeys = new Set(
      collectRecentErrors(now, workspaceStatus, recentErrors).map((error) =>
        getStatusRecentErrorKey(error)
      ),
    );
    const changed = reconcileSuppressedRecentErrorKeys(
      suppressedRecentErrorKeys,
      currentRecentErrorKeys,
    );
    if (changed) {
      await persistSuppressedRecentErrorKeysBestEffort(
        statusErrorCursorPath,
        suppressedRecentErrorKeys,
        now,
      );
    }
  }

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
      workspaceActiveCount: workspaceStatus?.activeCount,
      workspaceInvalidCount: workspaceStatus?.invalidCount,
      workspaceStatusUnavailable:
        workspaceStatus?.unavailableReason !== undefined,
      webConfigured: webStatus.configured,
      webState: webStatus.state,
    },
  );
  await ctx.auditLogger.command("status", { asJson, showAll });

  if (asJson) {
    const filtered = filterSnapshotForJson(snapshot, showAll);
    const recordingActivity = summarizeRecordingActivity(
      snapshot.sessions,
      snapshot.recordings,
    );
    ctx.runtime.writeStdout(
      `${
        JSON.stringify(
          {
            ...filtered,
            recordings: {
              ...filtered.recordings,
              inactiveRecordings: recordingActivity.inactiveRecordings,
            },
            web: webStatus,
          },
          null,
          2,
        )
      }\n`,
    );
    return;
  }

  const terminalWidth = resolveTerminalWidth();
  ctx.runtime.writeStdout(
    renderStatusText(snapshot, {
      showAll,
      now,
      stale,
      terminalWidth,
      workspaceStatus,
      webStatus,
      showWorkspaceDetails: true,
      recentErrors,
      suppressedRecentErrorKeys,
      colorize: shouldColorizeStatusOutput(),
    }) + "\n",
  );
}
