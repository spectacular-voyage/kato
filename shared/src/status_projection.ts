/**
 * Pure status projection helpers shared by daemon, CLI, and web.
 * No Deno-specific APIs; plain TypeScript only.
 */

import type { ConversationEvent } from "./contracts/events.ts";
import type {
  DaemonRecordingStatus,
  DaemonSessionStatus,
} from "./contracts/status.ts";
import type { ProviderSessionTitleSource } from "./contracts/session_state.ts";

export const DEFAULT_STATUS_STALE_AFTER_MS = 5 * 60_000;
const SNIPPET_MAX_CHARS = 60;

/** Narrow input shapes so callers don't need to import daemon-internal types. */

export interface SessionProjectionInput {
  provider: string;
  sessionId: string;
  sessionShortId?: string;
  providerSessionId?: string;
  updatedAt: string;
  lastEventAt?: string;
  /** File mtime in ms, available for diagnostics. */
  fileModifiedAtMs?: number;
  /** Pre-computed snippet from metadata. Preferred over scanning events. */
  snippet?: string;
  /** Provider-maintained session title. Preferred over the snippet. */
  providerTitle?: string;
  providerTitleSource?: ProviderSessionTitleSource;
  /** Events array — only needed when snippet is not cached. */
  events?: ConversationEvent[];
}

export interface RecordingProjectionInput {
  provider: string;
  sessionId: string;
  recordingId?: string;
  recordingShortId?: string;
  workspaceAlias?: string;
  outputPath: string;
  startedAt: string;
  restartedAt?: string;
  lastWriteAt: string;
}

export interface RecordingActivitySummary {
  activeRecordings: number;
  inactiveRecordings: number;
  destinations: number;
}

/**
 * Derive a short snippet from the first user message in a session's events.
 * Using the first message keeps the label stable as the conversation grows.
 * Returns `undefined` if no non-empty user message is found.
 */
export function extractSnippet(
  events: ConversationEvent[],
): string | undefined {
  for (const ev of events) {
    if (ev.kind === "message.user") {
      const firstLine = ev.content.split(/\r?\n|\r/).find((l) =>
        l.trim().length > 0
      )?.trim();
      if (!firstLine) continue;
      if (firstLine.length <= SNIPPET_MAX_CHARS) return firstLine;
      return firstLine.slice(0, SNIPPET_MAX_CHARS - 1) + "…";
    }
  }
  return undefined;
}

/**
 * Returns true if the session's `updatedAt` timestamp is older than
 * `staleAfterMs` relative to `now`, or if the timestamp is unparseable.
 */
export function isSessionStale(
  updatedAt: string,
  now: Date,
  staleAfterMs: number = DEFAULT_STATUS_STALE_AFTER_MS,
): boolean {
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return true;
  return now.getTime() - ts > staleAfterMs;
}

/**
 * Project a single session snapshot + optional active recording into a
 * `DaemonSessionStatus` suitable for status display.
 */
export function projectSessionStatus(opts: {
  session: SessionProjectionInput;
  recordings?: RecordingProjectionInput[];
  now: Date;
  staleAfterMs?: number;
}): DaemonSessionStatus {
  const { session, recordings, now, staleAfterMs } = opts;
  // Staleness is derived strictly from event time.
  // We intentionally do not fallback to mtime/updatedAt so missing lastEventAt
  // remains visible as a data issue.
  const stale = session.lastEventAt !== undefined
    ? isSessionStale(
      session.lastEventAt,
      now,
      staleAfterMs ?? DEFAULT_STATUS_STALE_AFTER_MS,
    )
    : true;

  const result: DaemonSessionStatus = {
    provider: session.provider,
    sessionId: session.sessionId,
    ...(session.sessionShortId
      ? { sessionShortId: session.sessionShortId }
      : {}),
    ...(session.providerSessionId
      ? { providerSessionId: session.providerSessionId }
      : {}),
    snippet: session.providerTitle ?? session.snippet ??
      extractSnippet(session.events ?? []),
    ...(session.providerTitle && session.providerTitleSource
      ? { titleSource: session.providerTitleSource }
      : {}),
    updatedAt: session.updatedAt,
    ...(session.lastEventAt ? { lastEventAt: session.lastEventAt } : {}),
    stale,
  };

  if (recordings && recordings.length > 0) {
    result.recordings = recordings.map((recording): DaemonRecordingStatus => ({
      ...(recording.recordingId ? { recordingId: recording.recordingId } : {}),
      ...(recording.recordingShortId
        ? { recordingShortId: recording.recordingShortId }
        : {}),
      ...(recording.workspaceAlias
        ? { workspaceAlias: recording.workspaceAlias }
        : {}),
      outputPath: recording.outputPath,
      startedAt: recording.startedAt,
      ...(recording.restartedAt ? { restartedAt: recording.restartedAt } : {}),
      lastWriteAt: recording.lastWriteAt,
    }));
  }

  return result;
}

/**
 * Key used for recency sorting.
 *
 * Sort by daemon ingest recency (`updatedAt`) only.
 */
function recencyKey(s: DaemonSessionStatus): number {
  const parsed = Date.parse(s.updatedAt);
  if (Number.isNaN(parsed)) return 0;
  // Floor to minute granularity to prevent active sessions from flapping
  return Math.floor(parsed / 60_000) * 60_000;
}

function hasActiveRecording(s: DaemonSessionStatus): boolean {
  return !s.stale && (s.recordings?.length ?? 0) > 0;
}

/**
 * Summarize recording activity from session status rows.
 *
 * Inactive recordings are counted as:
 * - active sessions with no current recording
 * - recordings attached to stale sessions
 */
export function summarizeRecordingActivity(
  sessions: DaemonSessionStatus[] | undefined,
  fallback?: { activeRecordings: number; destinations: number },
): RecordingActivitySummary {
  if (!sessions) {
    return {
      activeRecordings: fallback?.activeRecordings ?? 0,
      inactiveRecordings: 0,
      destinations: fallback?.destinations ?? 0,
    };
  }

  let activeRecordings = 0;
  let inactiveRecordings = 0;
  const destinations = new Set<string>();

  for (const session of sessions) {
    const recordings = session.recordings ?? [];
    if (session.stale) {
      inactiveRecordings += recordings.length;
      continue;
    }
    if (recordings.length === 0) {
      inactiveRecordings += 1;
      continue;
    }
    activeRecordings += recordings.length;
    for (const recording of recordings) {
      destinations.add(recording.outputPath);
    }
  }

  return {
    activeRecordings,
    inactiveRecordings,
    destinations: destinations.size,
  };
}

/**
 * Sort sessions with active recordings first, then by `updatedAt`
 * descending, then by provider+sessionId as tiebreaker.
 */
export function sortSessionsByRecency(
  sessions: DaemonSessionStatus[],
): DaemonSessionStatus[] {
  return [...sessions].sort((a, b) => {
    const recordingDiff = Number(hasActiveRecording(b)) -
      Number(hasActiveRecording(a));
    if (recordingDiff !== 0) return recordingDiff;

    const diff = recencyKey(b) - recencyKey(a);
    if (diff !== 0) return diff;
    return `${a.provider}/${a.sessionId}`.localeCompare(
      `${b.provider}/${b.sessionId}`,
    );
  });
}

/**
 * Filter and sort sessions for display.
 *
 * - `includeStale: false` (default) — active sessions only.
 * - `includeStale: true` — all sessions.
 *
 * Result is always sorted by recency descending.
 */
export function filterSessionsForDisplay(
  sessions: DaemonSessionStatus[],
  opts: { includeStale: boolean },
): DaemonSessionStatus[] {
  const filtered = opts.includeStale
    ? sessions
    : sessions.filter((s) => !s.stale);
  return sortSessionsByRecency(filtered);
}
