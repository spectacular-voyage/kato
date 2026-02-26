/**
 * Pure status projection helpers shared by daemon, CLI, and web.
 * No Deno-specific APIs; plain TypeScript only.
 */

import type { ConversationEvent } from "./contracts/events.ts";
import type {
  DaemonRecordingStatus,
  DaemonSessionStatus,
} from "./contracts/status.ts";

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
  /** File mtime in ms — most reliable staleness signal, provider-agnostic. */
  fileModifiedAtMs?: number;
  /** Pre-computed snippet from metadata. Preferred over scanning events. */
  snippet?: string;
  /** Events array — only needed when snippet is not cached. */
  events?: ConversationEvent[];
}

export interface RecordingProjectionInput {
  provider: string;
  sessionId: string;
  recordingId?: string;
  recordingShortId?: string;
  outputPath: string;
  startedAt: string;
  lastWriteAt: string;
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
      const text = ev.content.replace(/\r?\n|\r/g, " ").trim();
      if (text.length === 0) continue;
      if (text.length <= SNIPPET_MAX_CHARS) return text;
      return text.slice(0, SNIPPET_MAX_CHARS - 1) + "…";
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
  recording?: RecordingProjectionInput;
  now: Date;
  staleAfterMs?: number;
}): DaemonSessionStatus {
  const { session, recording, now, staleAfterMs } = opts;
  // Staleness precedence:
  //   1. fileModifiedAtMs — OS-level mtime, reliable across all providers
  //   2. lastEventAt     — fallback for providers without mtime support
  //   3. absent          — no evidence of activity → stale
  // We avoid updatedAt because it resets to now() on every daemon restart.
  let stale: boolean;
  if (session.fileModifiedAtMs !== undefined) {
    stale = now.getTime() - session.fileModifiedAtMs >
      (staleAfterMs ?? DEFAULT_STATUS_STALE_AFTER_MS);
  } else if (session.lastEventAt !== undefined) {
    stale = isSessionStale(
      session.lastEventAt,
      now,
      staleAfterMs ?? DEFAULT_STATUS_STALE_AFTER_MS,
    );
  } else {
    stale = true;
  }

  const result: DaemonSessionStatus = {
    provider: session.provider,
    sessionId: session.sessionId,
    ...(session.sessionShortId ? { sessionShortId: session.sessionShortId } : {}),
    ...(session.providerSessionId
      ? { providerSessionId: session.providerSessionId }
      : {}),
    snippet: session.snippet ?? extractSnippet(session.events ?? []),
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastEventAt,
    stale,
  };

  if (recording) {
    const rec: DaemonRecordingStatus = {
      ...(recording.recordingId ? { recordingId: recording.recordingId } : {}),
      ...(recording.recordingShortId
        ? { recordingShortId: recording.recordingShortId }
        : {}),
      outputPath: recording.outputPath,
      startedAt: recording.startedAt,
      lastWriteAt: recording.lastWriteAt,
    };
    result.recording = rec;
  }

  return result;
}

/**
 * Key used for recency sorting: prefer lastWriteAt > lastMessageAt > updatedAt.
 */
function recencyKey(s: DaemonSessionStatus): number {
  const ts = s.recording?.lastWriteAt ?? s.lastMessageAt ?? s.updatedAt;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Sort sessions by recency descending, then by provider+sessionId as tiebreaker.
 */
export function sortSessionsByRecency(
  sessions: DaemonSessionStatus[],
): DaemonSessionStatus[] {
  return [...sessions].sort((a, b) => {
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
