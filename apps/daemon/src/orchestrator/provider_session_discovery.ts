export interface SessionDiscoveryCandidate {
  sessionId: string;
  filePath: string;
  modifiedAtMs: number;
  contentUpdatedAtMs?: number;
  layoutType?: "hash" | "slug" | "unknown";
}

export interface DedupeDiscoveredSessionsResult<
  T extends SessionDiscoveryCandidate,
> {
  sessions: T[];
  droppedEvents: number;
  duplicateSessionIds: string[];
}

function geminiLayoutRank(
  layoutType: SessionDiscoveryCandidate["layoutType"],
): number {
  switch (layoutType) {
    case "slug":
      return 2;
    case "hash":
      return 1;
    default:
      return 0;
  }
}

export function compareDiscoveredSessionCandidates<
  T extends SessionDiscoveryCandidate,
>(
  a: T,
  b: T,
): number {
  const aContentUpdated = a.contentUpdatedAtMs ?? Number.NEGATIVE_INFINITY;
  const bContentUpdated = b.contentUpdatedAtMs ?? Number.NEGATIVE_INFINITY;
  if (aContentUpdated !== bContentUpdated) {
    return bContentUpdated - aContentUpdated;
  }

  const aLayoutRank = geminiLayoutRank(a.layoutType);
  const bLayoutRank = geminiLayoutRank(b.layoutType);
  if (aLayoutRank !== bLayoutRank) {
    return bLayoutRank - aLayoutRank;
  }

  if (a.modifiedAtMs !== b.modifiedAtMs) {
    return b.modifiedAtMs - a.modifiedAtMs;
  }

  return a.filePath.localeCompare(b.filePath);
}

export function dedupeDiscoveredSessions<T extends SessionDiscoveryCandidate>(
  sessions: T[],
): DedupeDiscoveredSessionsResult<T> {
  const bySessionId = new Map<string, T>();
  const duplicateSessionIds = new Set<string>();
  let droppedEvents = 0;

  const sorted = [...sessions].sort((a, b) => {
    if (a.sessionId === b.sessionId) {
      return compareDiscoveredSessionCandidates(a, b);
    }
    return a.sessionId.localeCompare(b.sessionId);
  });

  for (const session of sorted) {
    if (!bySessionId.has(session.sessionId)) {
      bySessionId.set(session.sessionId, session);
      continue;
    }
    droppedEvents += 1;
    duplicateSessionIds.add(session.sessionId);
  }

  return {
    sessions: Array.from(bySessionId.values()),
    droppedEvents,
    duplicateSessionIds: Array.from(duplicateSessionIds).sort(),
  };
}
