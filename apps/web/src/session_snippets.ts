import { extractSnippet, type SessionMetadataV1 } from "@kato/shared";
import {
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  loadPersistedSessionHistoryEvents,
  mapTwinEventsToConversation,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  resolveDefaultStatusPath,
} from "@kato/runtime";

export interface ResolveSessionSnippetOptions {
  sessionId: string;
  katoDir?: string;
  allowSourceReplay?: boolean;
  now?: () => Date;
  statusStore?: DaemonStatusSnapshotStoreLike;
}

export interface ResolvedSessionSnippet {
  sessionId: string;
  status: "ready" | "unavailable";
  snippet?: string;
  source?: "live" | "twin" | "source";
}

function normalizeSnippet(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function findMetadataBySessionId(
  metadataList: SessionMetadataV1[],
  sessionId: string,
): SessionMetadataV1 | undefined {
  return metadataList.find((metadata) => metadata.sessionId === sessionId);
}

async function loadTwinSnippet(
  metadata: SessionMetadataV1,
  sessionStore: PersistentSessionStateStore,
): Promise<string | undefined> {
  try {
    const twinEvents = await sessionStore.readTwinEvents(metadata, 1);
    if (twinEvents.length === 0) {
      return undefined;
    }
    return normalizeSnippet(
      extractSnippet(mapTwinEventsToConversation(twinEvents)),
    );
  } catch {
    return undefined;
  }
}

export async function resolveSessionSnippet(
  options: ResolveSessionSnippetOptions,
): Promise<ResolvedSessionSnippet> {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const now = options.now ?? (() => new Date());
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(resolveDefaultStatusPath(katoDir), now);
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });
  const [snapshot, metadataList] = await Promise.all([
    statusStore.load(),
    sessionStore.listSessionMetadata(),
  ]);

  const liveSnippet = normalizeSnippet(
    snapshot.sessions?.find((session) =>
      session.sessionId === options.sessionId
    )
      ?.snippet,
  );
  if (liveSnippet) {
    return {
      sessionId: options.sessionId,
      status: "ready",
      snippet: liveSnippet,
      source: "live",
    };
  }

  const metadata = findMetadataBySessionId(metadataList, options.sessionId);
  if (!metadata) {
    return {
      sessionId: options.sessionId,
      status: "unavailable",
    };
  }

  if (options.allowSourceReplay === false) {
    const twinSnippet = await loadTwinSnippet(metadata, sessionStore);
    return twinSnippet
      ? {
        sessionId: options.sessionId,
        status: "ready",
        snippet: twinSnippet,
        source: "twin",
      }
      : {
        sessionId: options.sessionId,
        status: "unavailable",
      };
  }

  let history;
  try {
    history = await loadPersistedSessionHistoryEvents(
      metadata,
      sessionStore,
    );
  } catch {
    return {
      sessionId: options.sessionId,
      status: "unavailable",
    };
  }
  const snippet = normalizeSnippet(extractSnippet(history.events));
  if (!snippet) {
    return {
      sessionId: options.sessionId,
      status: "unavailable",
    };
  }

  return {
    sessionId: options.sessionId,
    status: "ready",
    snippet,
    source: history.source,
  };
}
