import type { ConversationEvent, ProviderCursor } from "@kato/shared";
import { memoizeForSealedEvent } from "./sealed_events.ts";

export interface MergeEventsOptions {
  ignoreTimestamp?: boolean;
  ignoreCursor?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function serializeCursor(cursor: ProviderCursor | undefined): string {
  if (!cursor) {
    return "";
  }
  return `${cursor.kind}:${String(cursor.value)}`;
}

function resolveStableCursorComponent(
  event: ConversationEvent,
  options: MergeEventsOptions = {},
): string {
  if (isNonEmptyString(event.turnId)) {
    return `turn:${event.turnId}`;
  }
  if (isNonEmptyString(event.source.providerEventId)) {
    return "";
  }
  if (options.ignoreCursor) {
    return "";
  }
  return serializeCursor(event.source.rawCursor);
}

function eventSignature(
  event: ConversationEvent,
  options: MergeEventsOptions = {},
): string {
  const stableCursorComponent = resolveStableCursorComponent(event, options);
  const timestamp = options.ignoreTimestamp ? "" : event.timestamp ?? "";
  const base = `${event.kind}\0${event.source.providerEventType}\0${
    event.source.providerEventId ?? ""
  }\0${timestamp}\0${stableCursorComponent}`;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
      return `${base}\0${event.content}`;
    case "tool.call":
      return `${base}\0${event.toolCallId}\0${event.name}\0${
        event.description ?? ""
      }\0${event.input !== undefined ? JSON.stringify(event.input) : ""}`;
    case "tool.result":
      return `${base}\0${event.toolCallId}\0${event.result}`;
    case "thinking":
      return `${base}\0${event.content}`;
    case "decision":
      return `${base}\0${event.decisionId}`;
    case "provider.info":
      return `${base}\0${event.content}`;
    default:
      return base;
  }
}

/** Per option combination: sealed event → signature. */
const sealedSignatureCaches = new Map<
  string,
  WeakMap<ConversationEvent, string>
>();

function cachedEventSignature(
  event: ConversationEvent,
  options: MergeEventsOptions,
): string {
  const variant = `${options.ignoreTimestamp ? 1 : 0}${
    options.ignoreCursor ? 1 : 0
  }`;
  let cache = sealedSignatureCaches.get(variant);
  if (!cache) {
    cache = new WeakMap();
    sealedSignatureCaches.set(variant, cache);
  }
  return memoizeForSealedEvent(
    cache,
    event,
    (value) => eventSignature(value, options),
  );
}

export function mergeEvents(
  existingEvents: ConversationEvent[],
  incomingEvents: ConversationEvent[],
  options: MergeEventsOptions = {},
): { mergedEvents: ConversationEvent[]; droppedEvents: number } {
  // Existing events normally come from the snapshot store (sealed), so their
  // signatures are computed once per event rather than on every merge.
  const signatures = new Set(
    existingEvents.map((event) => cachedEventSignature(event, options)),
  );
  const mergedEvents = [...existingEvents];
  let droppedEvents = 0;

  for (const event of incomingEvents) {
    const signature = cachedEventSignature(event, options);
    if (signatures.has(signature)) {
      droppedEvents += 1;
      continue;
    }
    signatures.add(signature);
    mergedEvents.push(event);
  }

  return { mergedEvents, droppedEvents };
}
