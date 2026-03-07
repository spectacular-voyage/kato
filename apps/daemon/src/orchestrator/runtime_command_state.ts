import type { ConversationEvent, SessionMetadataV1 } from "@kato/shared";
import type { InChatControlCommand } from "../policy/mod.ts";

export interface InChatCommandBoundary {
  command: InChatControlCommand;
  nextCommandLine: number;
  lastLineInSegment: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) return undefined;
  return timeMs;
}

function normalizeCommandCursorAnchor(
  value: SessionMetadataV1["commandCursorAnchor"] | undefined,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  if (!value) {
    return undefined;
  }
  const eventId = readString(value.eventId);
  const providerEventType = readString(value.providerEventType);
  const providerEventId = readString(value.providerEventId);
  const timestamp = readString(value.timestamp);
  if (!eventId && !(providerEventType && providerEventId) && !timestamp) {
    return undefined;
  }
  return {
    ...(eventId ? { eventId } : {}),
    ...(providerEventType ? { providerEventType } : {}),
    ...(providerEventId ? { providerEventId } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function commandCursorAnchorMatchesEvent(
  anchor: NonNullable<SessionMetadataV1["commandCursorAnchor"]>,
  event: ConversationEvent,
): boolean {
  if (anchor.eventId && event.eventId === anchor.eventId) {
    return true;
  }
  if (
    anchor.providerEventType &&
    anchor.providerEventId &&
    event.source.providerEventType === anchor.providerEventType &&
    event.source.providerEventId === anchor.providerEventId
  ) {
    return true;
  }
  return false;
}

function findCommandCursorAnchorIndex(
  events: ConversationEvent[],
  anchor: NonNullable<SessionMetadataV1["commandCursorAnchor"]>,
): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (commandCursorAnchorMatchesEvent(anchor, event)) {
      return i;
    }
  }
  return -1;
}

function findFirstEventAfterTimestamp(
  events: ConversationEvent[],
  timestamp: string,
): number {
  const anchorTimeMs = readTimeMs(timestamp);
  if (anchorTimeMs === undefined) {
    return events.length;
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    const eventTimeMs = readTimeMs(event.timestamp);
    if (eventTimeMs !== undefined && eventTimeMs > anchorTimeMs) {
      return i;
    }
  }
  return events.length;
}

function sliceContentByLineRange(
  content: string,
  startLineInclusive: number,
  endLineInclusive: number,
): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = Math.max(1, startLineInclusive);
  const end = Math.min(lines.length, endLineInclusive);
  if (end < start) {
    return "";
  }
  return lines.slice(start - 1, end).join("\n");
}

function withUserEventContent(
  event: ConversationEvent & { kind: "message.user" },
  content: string,
): ConversationEvent & { kind: "message.user" } {
  return {
    ...event,
    content,
  };
}

export function readCommandCursor(metadata: SessionMetadataV1): number {
  const raw = metadata.commandCursor;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return 0;
  }
  return raw;
}

export function readCommandCursorAnchor(
  metadata: SessionMetadataV1,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  return normalizeCommandCursorAnchor(metadata.commandCursorAnchor);
}

export function buildCommandCursorAnchor(
  event: ConversationEvent | undefined,
): SessionMetadataV1["commandCursorAnchor"] | undefined {
  if (!event) {
    return undefined;
  }
  return normalizeCommandCursorAnchor({
    eventId: event.eventId,
    providerEventType: event.source.providerEventType,
    providerEventId: event.source.providerEventId,
    timestamp: event.timestamp,
  });
}

export function resolveCommandStartCursor(
  metadata: SessionMetadataV1,
  events: ConversationEvent[],
): number {
  const anchor = readCommandCursorAnchor(metadata);
  if (anchor) {
    const anchorIndex = findCommandCursorAnchorIndex(events, anchor);
    if (anchorIndex >= 0) {
      return anchorIndex + 1;
    }
    if (anchor.timestamp) {
      return findFirstEventAfterTimestamp(events, anchor.timestamp);
    }
  }
  const persisted = readCommandCursor(metadata);
  if (persisted <= events.length) {
    return persisted;
  }
  return events.length;
}

export function commandCursorAnchorEquals(
  left: SessionMetadataV1["commandCursorAnchor"] | undefined,
  right: SessionMetadataV1["commandCursorAnchor"] | undefined,
): boolean {
  const leftNormalized = normalizeCommandCursorAnchor(left);
  const rightNormalized = normalizeCommandCursorAnchor(right);
  if (!leftNormalized && !rightNormalized) {
    return true;
  }
  if (!leftNormalized || !rightNormalized) {
    return false;
  }
  return leftNormalized.eventId === rightNormalized.eventId &&
    leftNormalized.providerEventType === rightNormalized.providerEventType &&
    leftNormalized.providerEventId === rightNormalized.providerEventId &&
    leftNormalized.timestamp === rightNormalized.timestamp;
}

export function writeCommandCursor(
  metadata: SessionMetadataV1,
  cursor: number,
  events: ConversationEvent[],
): void {
  const finiteCursor = Number.isFinite(cursor) ? cursor : 0;
  const normalizedCursor = Math.min(
    events.length,
    Math.max(0, Math.floor(finiteCursor)),
  );
  metadata.commandCursor = normalizedCursor;
  const anchoredEvent = normalizedCursor > 0
    ? events[normalizedCursor - 1]
    : undefined;
  const anchor = anchoredEvent
    ? buildCommandCursorAnchor(anchoredEvent)
    : undefined;
  if (anchor) {
    metadata.commandCursorAnchor = anchor;
  } else {
    delete metadata.commandCursorAnchor;
  }
}

export function resolveCommandBoundaries(
  content: string,
  commands: InChatControlCommand[],
): InChatCommandBoundary[] {
  if (commands.length === 0) {
    return [];
  }
  const totalLines = content.replace(/\r\n?/g, "\n").split("\n").length;
  return commands.map((command, index) => {
    const nextCommandLine = commands[index + 1]?.line ?? (totalLines + 1);
    const lastLineInSegment = Math.max(command.line, nextCommandLine - 1);
    return {
      command,
      nextCommandLine,
      lastLineInSegment,
    };
  });
}

export function buildBoundarySnapshotEvents(
  events: ConversationEvent[],
  eventIndex: number,
  event: ConversationEvent & { kind: "message.user" },
  boundaryLine: number,
): ConversationEvent[] {
  const slice = events.slice(0, eventIndex + 1);
  if (slice.length === 0) {
    return [];
  }
  const boundaryContent = sliceContentByLineRange(
    event.content,
    1,
    boundaryLine,
  );
  slice[slice.length - 1] = withUserEventContent(event, boundaryContent);
  return slice;
}

export function buildCommandSeedEvents(
  event: ConversationEvent & { kind: "message.user" },
  startLineInclusive: number,
  endLineInclusive: number,
): ConversationEvent[] {
  const content = sliceContentByLineRange(
    event.content,
    startLineInclusive,
    endLineInclusive,
  );
  if (content.trim().length === 0) {
    return [];
  }
  return [withUserEventContent(event, content)];
}
