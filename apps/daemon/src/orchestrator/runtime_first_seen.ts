import type { ConversationEvent } from "@kato/shared";

export type FirstSeenSourceFileFreshnessBasis =
  | "source.birthtime"
  | "source.mtime"
  | "metadata.lastObservedMtimeMs";

export interface FirstSeenSourceFileFreshness {
  sourceFileFreshnessMs?: number;
  sourceFileFreshnessBasis?: FirstSeenSourceFileFreshnessBasis;
}

export interface ResolveFirstSeenSourceFileFreshnessOptions {
  sourceFilePath: string | undefined;
  metadataLastObservedMtimeMs: number | undefined;
  statPath?: (
    path: string,
  ) => Promise<Pick<Deno.FileInfo, "birthtime" | "mtime">>;
}

function readTimeMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) return undefined;
  return timeMs;
}

export async function resolveFirstSeenSourceFileFreshness(
  options: ResolveFirstSeenSourceFileFreshnessOptions,
): Promise<FirstSeenSourceFileFreshness> {
  const sourceFilePath = options.sourceFilePath?.trim();
  if (sourceFilePath && !sourceFilePath.startsWith("[unknown:")) {
    try {
      const sourceFileInfo = await (options.statPath ?? Deno.stat)(
        sourceFilePath,
      );
      const sourceFileBirthtimeMs = sourceFileInfo.birthtime?.getTime();
      if (
        sourceFileBirthtimeMs !== undefined &&
        Number.isFinite(sourceFileBirthtimeMs)
      ) {
        return {
          sourceFileFreshnessMs: sourceFileBirthtimeMs,
          sourceFileFreshnessBasis: "source.birthtime",
        };
      }
      const sourceFileMtimeMs = sourceFileInfo.mtime?.getTime();
      if (
        sourceFileMtimeMs !== undefined &&
        Number.isFinite(sourceFileMtimeMs)
      ) {
        return {
          sourceFileFreshnessMs: sourceFileMtimeMs,
          sourceFileFreshnessBasis: "source.mtime",
        };
      }
    } catch {
      // Best-effort source freshness check; metadata fallback handles unavailable files.
    }
  }

  if (
    options.metadataLastObservedMtimeMs !== undefined &&
    Number.isFinite(options.metadataLastObservedMtimeMs)
  ) {
    return {
      sourceFileFreshnessMs: options.metadataLastObservedMtimeMs,
      sourceFileFreshnessBasis: "metadata.lastObservedMtimeMs",
    };
  }

  return {};
}

export function isFirstSeenProviderSessionUserEventEligible(options: {
  event: ConversationEvent & { kind: "message.user" };
  daemonStartMs: number;
  nearRealtimeGraceMs: number;
  sourceFileFreshnessMs: number | undefined;
}): boolean {
  const nearRealtimeThresholdMs = options.daemonStartMs -
    options.nearRealtimeGraceMs;
  const eventTimeMs = readTimeMs(options.event.timestamp);
  if (eventTimeMs !== undefined) {
    return eventTimeMs >= nearRealtimeThresholdMs;
  }
  if (options.sourceFileFreshnessMs !== undefined) {
    return options.sourceFileFreshnessMs >= nearRealtimeThresholdMs;
  }
  return false;
}

export function resolveFirstSeenProviderSessionCommandCursor(options: {
  events: ConversationEvent[];
  daemonStartMs: number;
  nearRealtimeGraceMs: number;
  sourceFileFreshnessMs: number | undefined;
}): {
  commandCursor: number;
  eligibleUserEvents: number;
  skippedUserEvents: number;
} {
  let commandCursor = options.events.length;
  let eligibleUserEvents = 0;
  let skippedUserEvents = 0;

  for (let i = 0; i < options.events.length; i += 1) {
    const event = options.events[i];
    if (!event || event.kind !== "message.user") {
      continue;
    }
    const eligible = isFirstSeenProviderSessionUserEventEligible({
      event,
      daemonStartMs: options.daemonStartMs,
      nearRealtimeGraceMs: options.nearRealtimeGraceMs,
      sourceFileFreshnessMs: options.sourceFileFreshnessMs,
    });
    if (!eligible) {
      skippedUserEvents += 1;
      continue;
    }
    eligibleUserEvents += 1;
    if (commandCursor === options.events.length) {
      commandCursor = i;
    }
  }

  return { commandCursor, eligibleUserEvents, skippedUserEvents };
}
