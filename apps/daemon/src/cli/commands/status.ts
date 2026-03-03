import type { DaemonSessionStatus, DaemonStatusSnapshot } from "@kato/shared";
import { filterSessionsForDisplay, isSessionStale } from "@kato/shared";
import { join } from "@std/path";
import type { DaemonCliCommandContext } from "./context.ts";
import { isStatusSnapshotStale } from "../../orchestrator/mod.ts";
import type { RegisteredWorkspace } from "../../workspace/mod.ts";
import {
  loadWorkspaceConfigOverrides,
  readWorkspaceConfigWorkspaceId,
} from "../../workspace/mod.ts";
import { resolveWorkspaceRegistryStore } from "./workspace_shared.ts";
import {
  loadSuppressedRecentErrorKeys,
  resolveStatusErrorCursorPath,
  saveSuppressedRecentErrorKeys,
} from "./status_error_cursor.ts";

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
const ANSI_OSC_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\][^\\u0007]*(?:\\u0007|${ANSI_ESCAPE}\\\\)`,
  "g",
);
const ANSI_CSI_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);

export interface WorkspaceStatusRow {
  workspaceId: string;
  alias: string;
  workspaceRoot: string;
  configPath: string;
  valid: boolean;
  invalidReason?: string;
}

export interface WorkspaceStatusSummary {
  activeCount: number;
  invalidCount: number;
  rows: WorkspaceStatusRow[];
  unavailableReason?: string;
}

export interface StatusRecentError {
  timestamp: string;
  level: "warn" | "error";
  channel: "operational" | "security-audit";
  event: string;
  message: string;
  source?: "log" | "workspace";
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

function formatWorkspaceValidationError(error: unknown): string {
  if (error instanceof Deno.errors.NotFound) {
    return "config file not found";
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return "permission denied while reading config";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return sanitizeInlineText(error.message);
  }
  return sanitizeInlineText(String(error));
}

function toWorkspaceStatusRow(
  entry: RegisteredWorkspace,
  opts: { valid: boolean; invalidReason?: string },
): WorkspaceStatusRow {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    valid: opts.valid,
    ...(opts.invalidReason ? { invalidReason: opts.invalidReason } : {}),
  };
}

async function validateWorkspaceEntry(
  entry: RegisteredWorkspace,
): Promise<WorkspaceStatusRow> {
  try {
    await loadWorkspaceConfigOverrides(entry.configPath);
    const configuredWorkspaceId = await readWorkspaceConfigWorkspaceId(
      entry.configPath,
      { allowMissing: true },
    );
    if (
      configuredWorkspaceId &&
      configuredWorkspaceId !== entry.workspaceId
    ) {
      return toWorkspaceStatusRow(entry, {
        valid: false,
        invalidReason:
          `workspaceId mismatch (registry=${entry.workspaceId}, config=${configuredWorkspaceId})`,
      });
    }
    return toWorkspaceStatusRow(entry, { valid: true });
  } catch (error) {
    return toWorkspaceStatusRow(entry, {
      valid: false,
      invalidReason: formatWorkspaceValidationError(error),
    });
  }
}

async function loadWorkspaceStatusSummary(
  ctx: DaemonCliCommandContext,
): Promise<WorkspaceStatusSummary> {
  let entries: RegisteredWorkspace[];
  try {
    entries = await resolveWorkspaceRegistryStore(ctx).load();
  } catch (error) {
    return {
      activeCount: 0,
      invalidCount: 0,
      rows: [],
      unavailableReason: formatWorkspaceValidationError(error),
    };
  }

  const rows = await Promise.all(
    entries.map((entry) => validateWorkspaceEntry(entry)),
  );
  rows.sort((a, b) =>
    a.alias.localeCompare(b.alias) ||
    a.workspaceId.localeCompare(b.workspaceId)
  );

  const activeCount = rows.filter((row) => row.valid).length;
  return {
    activeCount,
    invalidCount: rows.length - activeCount,
    rows,
  };
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
  };
}

async function loadRecentErrorsFromLog(
  filePath: string,
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
      const errorRecord = parseStatusRecentError(parsed);
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
  const [operational, securityAudit] = await Promise.all([
    loadRecentErrorsFromLog(operationalPath),
    loadRecentErrorsFromLog(securityAuditPath),
  ]);
  return [...operational, ...securityAudit]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, RECENT_ERRORS_LIMIT);
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
  const base = `${error.level}|${error.channel}|${event}|${message}`;
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
  return `${error.level}|${error.channel}|${event}|${message}`;
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
  const remainingErrors = [
    ...deriveWorkspaceStatusErrors(workspaceStatus, now),
    ...sortedLogErrors.slice(reservedLogSlots),
  ].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, Math.max(RECENT_ERRORS_LIMIT - reservedLogErrors.length, 0));
  return dedupeRecentErrors([...reservedLogErrors, ...remainingErrors])
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, RECENT_ERRORS_LIMIT);
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
    await saveSuppressedRecentErrorKeys(cursorPath, suppressedRecentErrorKeys, now);
  } catch {
    // Best-effort persistence: keep live output responsive even if cursor
    // writes fail due to transient filesystem issues.
  }
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
  if (!sessions) {
    return fallback ?? { activeRecordings: 0, destinations: 0 };
  }
  const activeRecordings = sessions.flatMap((session) =>
    !session.stale ? (session.recordings ?? []) : []
  );
  return {
    activeRecordings: activeRecordings.length,
    destinations:
      new Set(activeRecordings.map((recording) => recording.outputPath))
        .size,
  };
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
    `recordings: ${recordingSummary.activeRecordings} active, ${staleCount} stale sessions`;

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

  const recMarker = s.stale ? "○" : "●";
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
): string | undefined {
  if (!workspaceStatus) {
    return undefined;
  }
  if (workspaceStatus.unavailableReason) {
    return `workspaces: unavailable (${workspaceStatus.unavailableReason})`;
  }
  return `workspaces: ${workspaceStatus.activeCount} active, ${workspaceStatus.invalidCount} invalid`;
}

function renderWorkspaceSection(
  workspaceStatus: WorkspaceStatusSummary,
  width: number,
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
    `Workspaces (${workspaceStatus.activeCount} active, ${workspaceStatus.invalidCount} invalid)`,
    "",
  ];

  if (workspaceStatus.rows.length === 0) {
    lines.push("  (none registered)");
    return lines;
  }

  for (const row of workspaceStatus.rows) {
    const marker = row.valid ? "●" : "○";
    const alias = resolveDisplayWorkspaceAlias(row.alias);
    const statusLabel = row.valid
      ? "valid"
      : `invalid: ${row.invalidReason ?? "unknown error"}`;
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
    showWorkspaceDetails?: boolean;
    recentErrors?: StatusRecentError[];
    suppressedRecentErrorKeys?: ReadonlySet<string>;
  },
): string {
  const { showAll, now, stale } = opts;
  const sessionCap = opts.sessionCap ?? Infinity;
  const width = resolveRenderWidth(opts.terminalWidth);
  const divider = "─".repeat(width);
  const workspaceSummary = renderWorkspaceSummaryLine(opts.workspaceStatus);
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
  if (workspaceSummary) {
    lines.push(truncate(workspaceSummary, width));
  }
  lines.push(divider);
  if (opts.showWorkspaceDetails && opts.workspaceStatus) {
    lines.push(...renderWorkspaceSection(opts.workspaceStatus, width));
    lines.push(divider);
  }

  lines.push(`Recent Errors (${visibleRecentErrors.length})`);
  if (visibleRecentErrors.length > 0) {
    lines.push("");
    for (const recentError of visibleRecentErrors) {
      const channel = recentError.channel === "security-audit"
        ? "audit"
        : "operational";
      const detail = `[${
        formatLocalTimestamp(recentError.timestamp)
      }] ${recentError.level.toUpperCase()} ${channel} ${
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
      const [workspaceStatus, recentErrors] = await Promise.all([
        loadWorkspaceStatusSummary(ctx),
        loadRecentStatusErrors(ctx),
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
        recentErrors,
        suppressedRecentErrorKeys,
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
  const workspaceStatus = asJson
    ? undefined
    : await loadWorkspaceStatusSummary(ctx);
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
    renderStatusText(snapshot, {
      showAll,
      now,
      stale,
      terminalWidth,
      workspaceStatus,
      showWorkspaceDetails: true,
      recentErrors,
      suppressedRecentErrorKeys,
    }) + "\n",
  );
}
