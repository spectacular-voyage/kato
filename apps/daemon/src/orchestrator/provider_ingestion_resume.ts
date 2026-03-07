import type { ProviderCursor, SessionIngestAnchorV1 } from "@kato/shared";
import { hashStringFNV1a, stableStringify } from "../utils/hash.ts";

export interface ProviderIngestionCodexCompactionAnchor {
  lineEnd: number;
  anchor: SessionIngestAnchorV1;
}

export type ProviderIngestionResumeSource = "persisted" | "memory" | "default";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readAnchorStringField(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }
  return value.trim();
}

function normalizeGeminiMessageForAnchor(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: readAnchorStringField(message["type"]) ?? "",
    content: message["content"],
    displayContent: message["displayContent"],
    thoughts: message["thoughts"],
    toolCalls: message["toolCalls"],
    model: readAnchorStringField(message["model"]) ?? "",
  };
}

export function resolveByteOffset(cursor: ProviderCursor | undefined): number {
  if (cursor?.kind === "byte-offset" && Number.isFinite(cursor.value)) {
    return Math.max(0, Math.floor(cursor.value));
  }
  return 0;
}

export function resolveItemIndex(cursor: ProviderCursor | undefined): number {
  if (cursor?.kind === "item-index" && Number.isFinite(cursor.value)) {
    return Math.max(0, Math.floor(cursor.value));
  }
  return 0;
}

export function resolveCursorPosition(
  cursor: ProviderCursor | undefined,
): number {
  if (cursor?.kind === "byte-offset") {
    return resolveByteOffset(cursor);
  }
  if (cursor?.kind === "item-index") {
    return resolveItemIndex(cursor);
  }
  return 0;
}

export function cursorsEqual(
  a: ProviderCursor | undefined,
  b: ProviderCursor | undefined,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.kind === b.kind && a.value === b.value;
}

export function makeByteOffsetCursor(offset: number): ProviderCursor {
  return {
    kind: "byte-offset",
    value: Math.max(0, Math.floor(offset)),
  };
}

export function makeItemIndexCursor(index: number): ProviderCursor {
  return {
    kind: "item-index",
    value: Math.max(0, Math.floor(index)),
  };
}

export function buildGeminiMessageAnchor(
  message: Record<string, unknown>,
): SessionIngestAnchorV1 {
  const messageId = readAnchorStringField(message["id"]);
  const payloadHash = hashStringFNV1a(
    stableStringify(normalizeGeminiMessageForAnchor(message)),
  );
  return {
    ...(messageId ? { messageId } : {}),
    payloadHash,
  };
}

export function findGeminiAnchorIndex(
  messages: Record<string, unknown>[],
  anchor: SessionIngestAnchorV1,
): number | undefined {
  if (isNonEmptyString(anchor.messageId)) {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      const messageId = readAnchorStringField(message["id"]);
      if (messageId === anchor.messageId) {
        return index;
      }
    }
  }

  if (!isNonEmptyString(anchor.payloadHash)) {
    return undefined;
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const candidate = buildGeminiMessageAnchor(message);
    if (candidate.payloadHash === anchor.payloadHash) {
      return index;
    }
  }
  return undefined;
}

export function anchorsEqual(
  a: SessionIngestAnchorV1 | undefined,
  b: SessionIngestAnchorV1 | undefined,
): boolean {
  if (!a || !b) {
    return a === b;
  }
  if (isNonEmptyString(a.messageId) || isNonEmptyString(b.messageId)) {
    return (a.messageId ?? "") === (b.messageId ?? "");
  }
  return (a.payloadHash ?? "") === (b.payloadHash ?? "");
}

export function resolveInitialIngestionCursor(options: {
  persistedCursor: ProviderCursor | undefined;
  persistedSourceFilePath: string | undefined;
  memoryCursor: ProviderCursor | undefined;
  memoryCursorSourcePath: string | undefined;
  sessionFilePath: string;
}): {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  resumeSource: ProviderIngestionResumeSource;
  clearStoredCursor: boolean;
} {
  let existingCursor = options.persistedCursor ?? options.memoryCursor;
  let resumeSource: ProviderIngestionResumeSource = options.persistedCursor
    ? "persisted"
    : options.memoryCursor
    ? "memory"
    : "default";
  let clearStoredCursor = false;

  if (
    options.persistedSourceFilePath &&
    options.persistedSourceFilePath !== options.sessionFilePath
  ) {
    existingCursor = undefined;
    resumeSource = "persisted";
    clearStoredCursor = true;
  } else if (
    !options.persistedCursor &&
    options.memoryCursor &&
    options.memoryCursorSourcePath &&
    options.memoryCursorSourcePath !== options.sessionFilePath
  ) {
    existingCursor = undefined;
    resumeSource = "default";
    clearStoredCursor = true;
  }

  return {
    existingCursor,
    fromOffset: resolveCursorPosition(existingCursor),
    resumeSource,
    clearStoredCursor,
  };
}

export function resolveByteOffsetResume(options: {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  fileSize: number;
}): {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  truncated: boolean;
} {
  if (
    options.existingCursor?.kind !== "byte-offset" ||
    options.fromOffset <= options.fileSize
  ) {
    return {
      existingCursor: options.existingCursor,
      fromOffset: options.fromOffset,
      truncated: false,
    };
  }

  return {
    existingCursor: makeByteOffsetCursor(0),
    fromOffset: 0,
    truncated: true,
  };
}

export function resolveCodexCompactionResume(options: {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  persistedAnchor: SessionIngestAnchorV1 | undefined;
  latestCompactionAnchor: ProviderIngestionCodexCompactionAnchor | undefined;
  backtrackBytes: number;
}): {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  compactionAnchor: SessionIngestAnchorV1 | undefined;
  backtracked: boolean;
  previousOffset?: number;
  backtrackedOffset?: number;
} {
  const compactionAnchor = options.latestCompactionAnchor?.anchor;

  if (
    options.existingCursor?.kind !== "byte-offset" ||
    options.fromOffset <= 0 ||
    !options.latestCompactionAnchor ||
    options.latestCompactionAnchor.lineEnd > options.fromOffset ||
    anchorsEqual(options.persistedAnchor, options.latestCompactionAnchor.anchor)
  ) {
    return {
      existingCursor: options.existingCursor,
      fromOffset: options.fromOffset,
      compactionAnchor,
      backtracked: false,
    };
  }

  const backtrackedOffset = Math.max(
    0,
    options.latestCompactionAnchor.lineEnd - options.backtrackBytes,
  );
  return {
    existingCursor: makeByteOffsetCursor(backtrackedOffset),
    fromOffset: backtrackedOffset,
    compactionAnchor,
    backtracked: true,
    previousOffset: options.fromOffset,
    backtrackedOffset,
  };
}

export function resolveGeminiAnchorResume(options: {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  persistedAnchor: SessionIngestAnchorV1 | undefined;
  messages: Record<string, unknown>[] | undefined;
}): {
  existingCursor: ProviderCursor | undefined;
  fromOffset: number;
  replayedFromStart: boolean;
  realigned: boolean;
  previousOffset?: number;
  realignedOffset?: number;
} {
  if (
    options.existingCursor?.kind !== "item-index" ||
    options.fromOffset <= 0 ||
    !options.persistedAnchor ||
    !options.messages
  ) {
    return {
      existingCursor: options.existingCursor,
      fromOffset: options.fromOffset,
      replayedFromStart: false,
      realigned: false,
    };
  }

  const currentAnchor = options.messages[options.fromOffset - 1]
    ? buildGeminiMessageAnchor(options.messages[options.fromOffset - 1]!)
    : undefined;
  if (anchorsEqual(options.persistedAnchor, currentAnchor)) {
    return {
      existingCursor: options.existingCursor,
      fromOffset: options.fromOffset,
      replayedFromStart: false,
      realigned: false,
    };
  }

  const realignedIndex = findGeminiAnchorIndex(
    options.messages,
    options.persistedAnchor,
  );
  if (realignedIndex === undefined) {
    return {
      existingCursor: makeItemIndexCursor(0),
      fromOffset: 0,
      replayedFromStart: true,
      realigned: false,
      previousOffset: options.fromOffset,
    };
  }

  const realignedOffset = realignedIndex + 1;
  if (realignedOffset === options.fromOffset) {
    return {
      existingCursor: options.existingCursor,
      fromOffset: options.fromOffset,
      replayedFromStart: false,
      realigned: false,
    };
  }

  return {
    existingCursor: makeItemIndexCursor(realignedOffset),
    fromOffset: realignedOffset,
    replayedFromStart: false,
    realigned: true,
    previousOffset: options.fromOffset,
    realignedOffset,
  };
}

export function resolveNextIngestAnchor(options: {
  provider: string;
  previousAnchor: SessionIngestAnchorV1 | undefined;
  latestCursor: ProviderCursor;
  geminiMessages: Record<string, unknown>[] | undefined;
  codexCompactionAnchor: SessionIngestAnchorV1 | undefined;
}): {
  nextAnchor: SessionIngestAnchorV1 | undefined;
  anchorChanged: boolean;
} {
  let nextAnchor = options.previousAnchor;
  if (
    options.provider === "gemini" && options.latestCursor.kind === "item-index"
  ) {
    nextAnchor = undefined;
    const latestIndex = resolveItemIndex(options.latestCursor);
    if (latestIndex > 0) {
      const message = options.geminiMessages?.[latestIndex - 1];
      if (message) {
        nextAnchor = buildGeminiMessageAnchor(message);
      }
    }
  } else if (options.provider === "codex") {
    nextAnchor = options.codexCompactionAnchor;
  }

  return {
    nextAnchor,
    anchorChanged: !anchorsEqual(options.previousAnchor, nextAnchor),
  };
}
