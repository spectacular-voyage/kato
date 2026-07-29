import type {
  SecretsPolicyConfig,
  SessionMetadataV1,
  SessionTwinEventV1,
} from "@kato/shared";
import {
  createSecretsRedactor,
  PersistentSessionStateStore,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";

const FAIL_CLOSED_SECRETS_POLICY: SecretsPolicyConfig = {
  mode: "redact",
  disabledRules: [],
  allowlist: [],
};

const DISPLAY_TEXT_MAX_CHARS = 4000;

/** Twin kinds rendered expanded; everything else collapses by default. */
const EXPANDED_KINDS = new Set<string>(["user.message", "assistant.message"]);

export interface SessionTwinViewEvent {
  seq: number;
  kind: string;
  timestamp?: string;
  /** Short label for collapsed rows (e.g. a tool name). */
  label?: string;
  /** Redacted, truncated display text. Render as plain text only. */
  text: string;
  collapsed: boolean;
  truncated: boolean;
}

export interface SessionTwinViewHeader {
  provider: string;
  providerSessionId: string;
  sessionShortId: string;
  workingDirectory?: string;
  createdAt: string;
  updatedAt: string;
  /** `nextTwinSeq - 1`; approximate when lines were skipped. */
  eventCountEstimate: number;
  workspaceOutputs: Array<{
    workspaceId: string;
    outputPath: string;
    desiredState: string;
  }>;
}

export interface SessionTwinViewData {
  status: "ready" | "unknown-session";
  sessionId: string;
  header?: SessionTwinViewHeader;
  events: SessionTwinViewEvent[];
  hasOlder: boolean;
  hasNewer: boolean;
  skippedLines: number;
  oldestSeq?: number;
  newestSeq?: number;
}

export interface LoadSessionTwinViewOptions {
  sessionId: string;
  beforeSeq?: number;
  afterSeq?: number;
  katoDir?: string;
  now?: () => Date;
}

async function loadSecretsPolicyBestEffort(
  katoDir: string,
): Promise<SecretsPolicyConfig | undefined> {
  try {
    const config = await new SharedBehaviorConfigFileStore(
      resolveDefaultSharedConfigPath(katoDir),
    ).load();
    return config.secretsPolicy;
  } catch {
    // Fail closed: absent policy means the caller redacts by default.
    return undefined;
  }
}

function extractDisplayText(event: SessionTwinEventV1): {
  label?: string;
  text: string;
} {
  const payload = event.payload;
  const label = typeof payload["name"] === "string"
    ? payload["name"]
    : undefined;
  const text = typeof payload["text"] === "string"
    ? payload["text"]
    : typeof payload["result"] === "string"
    ? payload["result"]
    : JSON.stringify(payload);
  return { ...(label ? { label } : {}), text };
}

export async function loadSessionTwinViewData(
  options: LoadSessionTwinViewOptions,
): Promise<SessionTwinViewData> {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const now = options.now ?? (() => new Date());
  const sessionStore = new PersistentSessionStateStore({ katoDir, now });
  const metadataList = await sessionStore.listSessionMetadata();
  const metadata: SessionMetadataV1 | undefined = metadataList.find((entry) =>
    entry.sessionId === options.sessionId
  );
  if (!metadata) {
    return {
      status: "unknown-session",
      sessionId: options.sessionId,
      events: [],
      hasOlder: false,
      hasNewer: false,
      skippedLines: 0,
    };
  }

  const [window, secretsPolicy] = await Promise.all([
    sessionStore.readTwinEventsWindow(metadata, {
      beforeSeq: options.beforeSeq,
      afterSeq: options.afterSeq,
    }),
    loadSecretsPolicyBestEffort(katoDir),
  ]);
  // Stored twins may predate ingestion-time filtering; always re-apply the
  // policy (fail-closed default) before anything reaches the browser.
  const redactor = createSecretsRedactor(
    secretsPolicy ?? FAIL_CLOSED_SECRETS_POLICY,
  );

  const events: SessionTwinViewEvent[] = window.events.map((event) => {
    const { label, text } = extractDisplayText(event);
    let displayText = text;
    if (redactor.mode === "redact") {
      try {
        displayText = redactor.processText(text).text;
      } catch {
        displayText = "(content withheld: redaction failed)";
      }
    }
    const truncated = displayText.length > DISPLAY_TEXT_MAX_CHARS;
    return {
      seq: event.seq,
      kind: event.kind,
      ...(event.time?.providerTimestamp
        ? { timestamp: event.time.providerTimestamp }
        : {}),
      ...(label ? { label } : {}),
      text: truncated
        ? displayText.slice(0, DISPLAY_TEXT_MAX_CHARS) + " … (truncated)"
        : displayText,
      collapsed: !EXPANDED_KINDS.has(event.kind),
      truncated,
    };
  });

  return {
    status: "ready",
    sessionId: options.sessionId,
    header: {
      provider: metadata.provider,
      providerSessionId: metadata.providerSessionId,
      sessionShortId: metadata.sessionId.slice(0, 8),
      ...(metadata.workingDirectory
        ? { workingDirectory: metadata.workingDirectory }
        : {}),
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      eventCountEstimate: Math.max(0, metadata.nextTwinSeq - 1),
      workspaceOutputs: (metadata.workspaceOutputs ?? []).map((output) => ({
        workspaceId: output.workspaceId,
        outputPath: output.currentResolvedPath,
        desiredState: output.desiredState,
      })),
    },
    events,
    hasOlder: window.hasOlder,
    hasNewer: window.hasNewer,
    skippedLines: window.skippedLines,
    ...(events.length > 0 ? { oldestSeq: events[0]!.seq } : {}),
    ...(events.length > 0 ? { newestSeq: events[events.length - 1]!.seq } : {}),
  };
}
