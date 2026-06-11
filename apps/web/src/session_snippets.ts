import {
  extractSnippet,
  type SecretsPolicyConfig,
  type SessionMetadataV1,
} from "@kato/shared";
import {
  createSecretsRedactor,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  loadPersistedSessionHistoryEvents,
  mapTwinEventsToConversation,
  PersistentSessionStateStore,
  redactConversationEvents,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  resolveDefaultStatusPath,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";

const FAIL_CLOSED_SECRETS_POLICY: SecretsPolicyConfig = {
  mode: "redact",
  disabledRules: [],
  allowlist: [],
};

async function loadSecretsPolicyBestEffort(
  katoDir: string,
): Promise<SecretsPolicyConfig | undefined> {
  try {
    const config = await new SharedBehaviorConfigFileStore(
      resolveDefaultSharedConfigPath(katoDir),
    ).load();
    return config.secretsPolicy;
  } catch {
    // Fail closed: replay redaction defaults to redact when policy is absent.
    return undefined;
  }
}

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
  secretsPolicy: SecretsPolicyConfig | undefined,
): Promise<string | undefined> {
  try {
    const twinEvents = await sessionStore.readTwinEvents(metadata, 1);
    if (twinEvents.length === 0) {
      return undefined;
    }
    const redactor = createSecretsRedactor(
      secretsPolicy ?? FAIL_CLOSED_SECRETS_POLICY,
    );
    const { events } = redactConversationEvents(
      mapTwinEventsToConversation(twinEvents),
      redactor,
    );
    return normalizeSnippet(
      extractSnippet(events),
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
  const secretsPolicy = await loadSecretsPolicyBestEffort(katoDir);

  if (options.allowSourceReplay === false) {
    const twinSnippet = await loadTwinSnippet(
      metadata,
      sessionStore,
      secretsPolicy,
    );
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
      { secretsPolicy },
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
