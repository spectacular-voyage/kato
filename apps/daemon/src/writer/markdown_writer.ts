import type { ConversationEvent } from "@kato/shared";
import { basename, dirname } from "@std/path";
import * as posixPath from "@std/path/posix";
import * as windowsPath from "@std/path/windows";
import {
  isPathWithinRoots,
  resolveDendronWikilinkContext,
} from "../../../runtime/src/mod.ts";
import {
  mergeAccretiveFrontmatterFields,
  renderFrontmatter,
} from "./frontmatter.ts";

export type ConversationWriteMode = "create" | "append" | "overwrite";

export interface MarkdownWriteResult {
  mode: ConversationWriteMode;
  outputPath: string;
  wrote: boolean;
  deduped: boolean;
}

export interface MarkdownSpeakerNames {
  user?: string;
  assistant?: string;
  system?: string;
}

export type MarkdownLinkStyle = "standard" | "dendron-wikilink";

export interface MarkdownRenderOptions {
  includeFrontmatter?: boolean;
  includeUpdatedInFrontmatter?: boolean;
  title?: string;
  now?: () => Date;
  makeFrontmatterId?: (title: string) => string;
  frontmatterSessionIds?: string[];
  frontmatterWorkspaceIds?: string[];
  frontmatterRecordingCycleIds?: string[];
  frontmatterParticipants?: string[];
  frontmatterTags?: string[];
  frontmatterConversationEventKinds?: string[];
  includeCommentary?: boolean;
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
  includeDecisionPrompt?: boolean;
  includeDecisionOptions?: boolean;
  includeDecisionSelection?: boolean;
  includeThinking?: boolean;
  italicizeUserMessages?: boolean;
  includeSystemEvents?: boolean;
  truncateToolResults?: number;
  requireCreateNew?: boolean;
  speakerNames?: MarkdownSpeakerNames;
  headingTimestampTimezone?: string;
  markdownLinkStyle?: MarkdownLinkStyle;
  relativizeLocalLinks?: boolean;
  renderOutputPath?: string;
  wikilinkifiableRoots?: string[];
}

export interface ConversationWriterLike {
  appendEvents(
    outputPath: string,
    events: ConversationEvent[],
    options?: MarkdownRenderOptions,
  ): Promise<MarkdownWriteResult>;
  overwriteEvents(
    outputPath: string,
    events: ConversationEvent[],
    options?: MarkdownRenderOptions,
  ): Promise<MarkdownWriteResult>;
}

function readDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function formatHeadingTimestamp(
  timestamp: string | undefined,
  headingTimestampTimezone: string | undefined,
): string {
  if (!timestamp) {
    return "unknown-time";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const baseFormatterOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  } as const;

  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      ...baseFormatterOptions,
      ...(headingTimestampTimezone &&
          headingTimestampTimezone !== "local"
        ? { timeZone: headingTimestampTimezone }
        : {}),
    });
    parts = formatter.formatToParts(date);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    parts = new Intl.DateTimeFormat("en-CA", baseFormatterOptions)
      .formatToParts(date);
  }

  const year = readDatePart(parts, "year");
  const month = readDatePart(parts, "month");
  const day = readDatePart(parts, "day");
  const hour = readDatePart(parts, "hour");
  const minute = readDatePart(parts, "minute");
  const second = readDatePart(parts, "second");
  if (
    year.length === 0 ||
    month.length === 0 ||
    day.length === 0 ||
    hour.length === 0 ||
    minute.length === 0 ||
    second.length === 0
  ) {
    return "unknown-time";
  }

  return `${year}-${month}-${day}_${hour}${minute}_${second}`;
}

function formatModelName(model: string): string {
  return model.replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

function resolveAssistantSpeaker(
  model: string | undefined,
  speakerNames: MarkdownSpeakerNames | undefined,
): string {
  return model
    ? formatModelName(model)
    : (speakerNames?.assistant ?? "Assistant");
}

function resolveLastAssistantSpeaker(
  lastAssistantSpeaker: string,
  model: string | undefined,
  speakerNames: MarkdownSpeakerNames | undefined,
): string {
  const normalizedModel = model?.trim();
  if (normalizedModel && normalizedModel.length > 0) {
    return formatModelName(normalizedModel);
  }
  if (lastAssistantSpeaker.trim().length > 0) {
    return lastAssistantSpeaker;
  }
  return speakerNames?.assistant ?? "Assistant";
}

function resolveInitialAssistantSpeaker(
  events: ConversationEvent[],
  speakerNames: MarkdownSpeakerNames | undefined,
): string {
  for (const event of events) {
    if (event.kind !== "message.assistant") {
      continue;
    }
    const normalizedModel = event.model?.trim();
    if (normalizedModel && normalizedModel.length > 0) {
      return formatModelName(normalizedModel);
    }
  }
  return speakerNames?.assistant ?? "Assistant";
}

function formatUserMessageContent(content: string): string {
  return content.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return "";
    }
    return `*${trimmed.replace(/\*/g, "\\*")}*`;
  }).join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

const MARKDOWN_INLINE_LINK_PATTERN = /^(!)?\[([^\]]+)\]\(([^)\n]+)\)/;

interface ParsedMarkdownLinkDestination {
  destination: string;
  suffix: string;
  wrapInAngles: boolean;
}

interface MarkdownInlineLinkMatch {
  fullMatch: string;
  isImage: boolean;
  label: string;
  rawDestination: string;
}

interface MarkdownLinkRenderContext {
  markdownLinkStyle: MarkdownLinkStyle;
  relativizeLocalLinks: boolean;
  renderOutputPath?: string;
  wikilinkifiableRoots: string[];
}

function parseMarkdownLinkDestination(
  rawDestination: string,
): ParsedMarkdownLinkDestination | null {
  const trimmed = rawDestination.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("<")) {
    const closeIndex = trimmed.indexOf(">");
    if (closeIndex <= 1) {
      return null;
    }
    return {
      destination: trimmed.slice(1, closeIndex).trim(),
      suffix: trimmed.slice(closeIndex + 1),
      wrapInAngles: true,
    };
  }
  const whitespaceIndex = trimmed.search(/\s/);
  return whitespaceIndex >= 0
    ? {
      destination: trimmed.slice(0, whitespaceIndex).trim(),
      suffix: trimmed.slice(whitespaceIndex),
      wrapInAngles: false,
    }
    : {
      destination: trimmed,
      suffix: "",
      wrapInAngles: false,
    };
}

function trimMarkdownLinkDestination(rawDestination: string): string | null {
  return parseMarkdownLinkDestination(rawDestination)?.destination ?? null;
}

function rebuildMarkdownLinkDestination(
  parsed: ParsedMarkdownLinkDestination,
  destination: string,
): string {
  return `${
    parsed.wrapInAngles ? `<${destination}>` : destination
  }${parsed.suffix}`;
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isSchemeBasedDestination(value: string): boolean {
  return !isWindowsDrivePath(value) &&
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function splitDestinationPathQueryAndFragment(
  destination: string,
): { pathname: string; search: string; hash: string } {
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex >= 0
    ? destination.slice(0, hashIndex)
    : destination;
  const hash = hashIndex >= 0 ? destination.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  return queryIndex >= 0
    ? {
      pathname: beforeHash.slice(0, queryIndex),
      search: beforeHash.slice(queryIndex),
      hash,
    }
    : {
      pathname: beforeHash,
      search: "",
      hash,
    };
}

function detectPathFlavor(value: string): "posix" | "windows" | null {
  if (
    isWindowsDrivePath(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("\\")
  ) {
    return "windows";
  }
  if (value.startsWith("/")) {
    return "posix";
  }
  return null;
}

function isAbsoluteLocalDestinationPath(pathname: string): boolean {
  if (pathname.startsWith("//")) {
    return false;
  }
  return detectPathFlavor(pathname) !== null;
}

function computeRelativeMarkdownPath(
  absolutePath: string,
  renderOutputPath: string | undefined,
): string | null {
  if (!renderOutputPath) {
    return null;
  }

  const targetFlavor = detectPathFlavor(absolutePath);
  const outputFlavor = detectPathFlavor(renderOutputPath);
  if (!targetFlavor || !outputFlavor || targetFlavor !== outputFlavor) {
    return null;
  }

  const pathModule = targetFlavor === "windows" ? windowsPath : posixPath;
  const relativePath = pathModule.relative(
    pathModule.dirname(renderOutputPath),
    absolutePath,
  );
  const normalized =
    (relativePath.length > 0 ? relativePath : pathModule.basename(absolutePath))
      .replaceAll("\\", "/");
  if (normalized.length === 0 || isAbsoluteLocalDestinationPath(normalized)) {
    return null;
  }
  return normalized;
}

function resolveLocalDestinationAbsolutePath(
  pathname: string,
  renderOutputPath: string | undefined,
): string | null {
  if (pathname.length === 0) {
    return null;
  }
  if (isAbsoluteLocalDestinationPath(pathname)) {
    return pathname;
  }
  if (!renderOutputPath) {
    return null;
  }

  const outputFlavor = detectPathFlavor(renderOutputPath);
  if (!outputFlavor) {
    return null;
  }

  const pathModule = outputFlavor === "windows" ? windowsPath : posixPath;
  const resolvedPath = pathModule.resolve(
    pathModule.dirname(renderOutputPath),
    pathname,
  );
  return isAbsoluteLocalDestinationPath(resolvedPath) ? resolvedPath : null;
}

function rewriteMarkdownLinkDestination(
  rawDestination: string,
  renderOutputPath: string | undefined,
): string | null {
  const parsed = parseMarkdownLinkDestination(rawDestination);
  if (!parsed) {
    return null;
  }

  const destination = parsed.destination;
  if (
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    isSchemeBasedDestination(destination)
  ) {
    return null;
  }

  const { pathname, search, hash } = splitDestinationPathQueryAndFragment(
    destination,
  );
  if (!isAbsoluteLocalDestinationPath(pathname)) {
    return null;
  }

  const relativePath = computeRelativeMarkdownPath(pathname, renderOutputPath);
  if (!relativePath) {
    return null;
  }

  return rebuildMarkdownLinkDestination(
    parsed,
    `${relativePath}${search}${hash}`,
  );
}

function isEscapedMarkdownCharacter(content: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (content[cursor] !== "\\") {
      break;
    }
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function matchFenceMarker(
  content: string,
  index: number,
  lineStart: boolean,
): { character: "`" | "~"; length: number; text: string } | null {
  if (!lineStart) {
    return null;
  }
  const match = /^[ \t]*(`{3,}|~{3,})/.exec(content.slice(index));
  if (!match) {
    return null;
  }
  const marker = match[1]!;
  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
    text: match[0]!,
  };
}

function applyMarkdownLinkTransform(
  content: string,
  transform: (match: MarkdownInlineLinkMatch) => string | null,
): string {
  if (!content.includes("](")) {
    return content;
  }

  const output: string[] = [];
  let cursor = 0;
  let lineStart = true;
  let activeFence: { character: "`" | "~"; length: number } | null = null;
  let activeInlineCodeTicks = 0;

  while (cursor < content.length) {
    if (activeFence) {
      const closingFence = matchFenceMarker(content, cursor, lineStart);
      if (
        closingFence &&
        closingFence.character === activeFence.character &&
        closingFence.length >= activeFence.length
      ) {
        output.push(closingFence.text);
        cursor += closingFence.text.length;
        lineStart = false;
        activeFence = null;
        continue;
      }
      const character = content[cursor]!;
      output.push(character);
      lineStart = character === "\n";
      cursor += 1;
      continue;
    }

    const openingFence = matchFenceMarker(content, cursor, lineStart);
    if (openingFence) {
      output.push(openingFence.text);
      cursor += openingFence.text.length;
      lineStart = false;
      activeFence = {
        character: openingFence.character,
        length: openingFence.length,
      };
      continue;
    }

    if (activeInlineCodeTicks > 0) {
      const inlineFence = "`".repeat(activeInlineCodeTicks);
      if (content.startsWith(inlineFence, cursor)) {
        output.push(inlineFence);
        cursor += inlineFence.length;
        activeInlineCodeTicks = 0;
        lineStart = false;
        continue;
      }
      const character = content[cursor]!;
      output.push(character);
      lineStart = character === "\n";
      cursor += 1;
      continue;
    }

    if (content[cursor] === "`") {
      let tickCount = 1;
      while (content[cursor + tickCount] === "`") {
        tickCount += 1;
      }
      const inlineFence = "`".repeat(tickCount);
      output.push(inlineFence);
      cursor += inlineFence.length;
      activeInlineCodeTicks = tickCount;
      lineStart = false;
      continue;
    }

    const maybeLinkStart = content[cursor] === "[" ||
      (content[cursor] === "!" && content[cursor + 1] === "[");
    if (maybeLinkStart && !isEscapedMarkdownCharacter(content, cursor)) {
      const match = MARKDOWN_INLINE_LINK_PATTERN.exec(content.slice(cursor));
      if (match) {
        const [fullMatch, imageMarker, label, rawDestination] = match;
        const replacement = transform({
          fullMatch,
          isImage: imageMarker === "!",
          label,
          rawDestination,
        });
        output.push(replacement ?? fullMatch);
        cursor += fullMatch.length;
        lineStart = false;
        continue;
      }
    }

    const character = content[cursor]!;
    output.push(character);
    lineStart = character === "\n";
    cursor += 1;
  }

  return output.join("");
}

function resolveDendronWikilinkTarget(
  rawDestination: string,
  options: Pick<
    MarkdownLinkRenderContext,
    "renderOutputPath" | "wikilinkifiableRoots"
  >,
): string | null {
  const destination = trimMarkdownLinkDestination(rawDestination);
  if (
    !destination ||
    destination.startsWith("#") ||
    destination.startsWith("//")
  ) {
    return null;
  }
  if (isSchemeBasedDestination(destination)) {
    return null;
  }

  const { pathname, search, hash } = splitDestinationPathQueryAndFragment(
    destination,
  );
  if (search.length > 0) {
    return null;
  }
  if (!/\.md$/i.test(pathname)) {
    return null;
  }

  const resolvedPath = resolveLocalDestinationAbsolutePath(
    pathname,
    options.renderOutputPath,
  );
  if (
    !resolvedPath ||
    !isPathWithinRoots(resolvedPath, options.wikilinkifiableRoots)
  ) {
    return null;
  }

  const fragment = hash.startsWith("#") ? hash.slice(1) : "";
  const filename = resolvedPath.split(/[\\/]/).pop()?.trim() ?? "";
  const noteName = filename.replace(/\.md$/i, "");
  if (noteName.length === 0) {
    return null;
  }
  return fragment.length > 0 ? `${noteName}#${fragment}` : noteName;
}

function applyMarkdownLinkRendering(
  content: string,
  options: MarkdownLinkRenderContext,
): string {
  if (
    !content.includes("](") ||
    (options.markdownLinkStyle !== "dendron-wikilink" &&
      !options.relativizeLocalLinks)
  ) {
    return content;
  }

  return applyMarkdownLinkTransform(
    content,
    ({ isImage, label, rawDestination }) => {
      if (!isImage && options.markdownLinkStyle === "dendron-wikilink") {
        const wikilinkTarget = resolveDendronWikilinkTarget(
          rawDestination,
          options,
        );
        if (wikilinkTarget) {
          return `[[${wikilinkTarget}]]`;
        }
      }

      if (!options.relativizeLocalLinks) {
        return null;
      }
      const rewrittenDestination = rewriteMarkdownLinkDestination(
        rawDestination,
        options.renderOutputPath,
      );
      return rewrittenDestination
        ? `${isImage ? "!" : ""}[${label}](${rewrittenDestination})`
        : null;
    },
  );
}

function parseQuestionnaireOptionLines(
  metadata: Record<string, unknown> | undefined,
  linkRenderContext: MarkdownLinkRenderContext,
): string[] {
  const optionsValue = metadata?.["options"];
  return Array.isArray(optionsValue)
    ? optionsValue
      .filter((option): option is Record<string, unknown> =>
        typeof option === "object" && option !== null
      )
      .map((option) => {
        const label = String(option["label"] ?? "").trim();
        if (label.length === 0) return "";
        const description = applyMarkdownLinkRendering(
          String(option["description"] ?? "").trim(),
          linkRenderContext,
        );
        return description.length > 0
          ? `- ${label}: ${description}`
          : `- ${label}`;
      })
      .filter((line) => line.length > 0)
    : [];
}

function splitAcceptedDecisionSummary(
  summary: string,
): { prompt?: string; selection?: string } {
  const trimmed = summary.trim();
  const separator = " -> ";
  const separatorIndex = trimmed.lastIndexOf(separator);
  if (separatorIndex >= 0) {
    const prompt = trimmed.slice(0, separatorIndex).trim();
    const selection = trimmed.slice(separatorIndex + separator.length).trim();
    return {
      ...(prompt.length > 0 ? { prompt } : {}),
      ...(selection.length > 0 ? { selection } : {}),
    };
  }
  return {
    ...(trimmed.length > 0 ? { selection: trimmed } : {}),
  };
}

function normalizeDecisionContextKey(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function resolveDecisionHeadingSegment(decisionKey: string): string {
  const segment = decisionKey
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment.length > 0 ? segment : "unknown";
}

type MessageEvent = ConversationEvent & {
  kind: "message.user" | "message.assistant" | "message.system";
};

function isMessageEvent(event: ConversationEvent): event is MessageEvent {
  return (
    event.kind === "message.user" ||
    event.kind === "message.assistant" ||
    event.kind === "message.system"
  );
}

function formatMessageHeading(
  event: MessageEvent,
  speakerNames: MarkdownSpeakerNames | undefined,
  headingTimestampTimezone: string | undefined,
): string {
  let speaker: string;
  if (event.kind === "message.user") {
    speaker = speakerNames?.user ?? "User";
  } else if (event.kind === "message.system") {
    speaker = speakerNames?.system ?? "System";
  } else {
    const model = "model" in event ? event.model : undefined;
    speaker = resolveAssistantSpeaker(model, speakerNames);
  }
  return `# ${speaker}_${
    formatHeadingTimestamp(event.timestamp, headingTimestampTimezone)
  }`;
}

function makeEventSignature(event: ConversationEvent): string {
  const base = `${event.kind}\0${event.eventId}\0${event.timestamp ?? ""}`;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
      return `${base}\0${event.content}`;
    case "tool.call":
      return `${base}\0${event.toolCallId}\0${event.name}`;
    case "tool.result":
      return `${base}\0${event.toolCallId}`;
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

export function renderEventsToMarkdown(
  events: ConversationEvent[],
  options: MarkdownRenderOptions = {},
): string {
  const includeFrontmatter = options.includeFrontmatter !== false;
  const includeCommentary = options.includeCommentary ?? true;
  const includeToolCalls = options.includeToolCalls ?? true;
  const includeToolResults = options.includeToolResults ?? includeToolCalls;
  const includeDecisionPrompt = options.includeDecisionPrompt ?? true;
  const includeDecisionOptions = options.includeDecisionOptions ?? true;
  const includeDecisionSelection = options.includeDecisionSelection ?? true;
  const includeThinking = options.includeThinking ?? true;
  const italicizeUserMessages = options.italicizeUserMessages ?? false;
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const truncateToolResults = options.truncateToolResults ?? 4_000;
  const markdownLinkStyle = options.markdownLinkStyle ?? "standard";
  const wikilinkifiableRoots = options.wikilinkifiableRoots !== undefined
    ? [...options.wikilinkifiableRoots]
    : options.renderOutputPath && markdownLinkStyle === "dendron-wikilink"
    ? [dirname(options.renderOutputPath)]
    : [];
  const linkRenderContext: MarkdownLinkRenderContext = {
    markdownLinkStyle,
    relativizeLocalLinks: options.relativizeLocalLinks ?? false,
    renderOutputPath: options.renderOutputPath,
    wikilinkifiableRoots,
  };

  const parts: string[] = [];
  const questionnaireContextByKey = new Map<
    string,
    { prompt?: string; optionLines: string[] }
  >();

  if (includeFrontmatter) {
    const title = options.title ?? "Untitled Conversation";
    parts.push(
      renderFrontmatter({
        title,
        now: options.now?.() ?? new Date(),
        makeFrontmatterId: options.makeFrontmatterId,
        sessionIds: options.frontmatterSessionIds,
        workspaceIds: options.frontmatterWorkspaceIds,
        recordingCycleIds: options.frontmatterRecordingCycleIds,
        participants: options.frontmatterParticipants,
        tags: options.frontmatterTags,
        conversationEventKinds: options.frontmatterConversationEventKinds,
        includeUpdated: options.includeUpdatedInFrontmatter,
      }),
      "",
    );
  }

  let lastRole: string | undefined;
  let lastSignature: string | undefined;
  let lastAssistantSpeaker = resolveInitialAssistantSpeaker(
    events,
    options.speakerNames,
  );

  // Pass 2: Render events in sequence.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "message.assistant") {
      lastAssistantSpeaker = resolveLastAssistantSpeaker(
        lastAssistantSpeaker,
        event.model,
        options.speakerNames,
      );
    }

    if (isMessageEvent(event)) {
      if (event.kind === "message.system" && !includeSystemEvents) {
        continue;
      }
      if (
        event.kind === "message.assistant" &&
        event.phase === "commentary" &&
        !includeCommentary
      ) {
        continue;
      }

      const content = (event.kind === "message.user" && italicizeUserMessages)
        ? formatUserMessageContent(event.content)
        : event.content;
      const renderedContent = applyMarkdownLinkRendering(
        content,
        linkRenderContext,
      );

      if (renderedContent.trim().length === 0) {
        continue;
      }

      if (event.kind === "message.assistant") {
        const normalizedContent = renderedContent.trim();
        const nextEvent = events[i + 1];
        if (
          event.phase === "commentary" &&
          nextEvent?.kind === "message.assistant" &&
          nextEvent.phase === "final" &&
          nextEvent.turnId === event.turnId &&
          applyMarkdownLinkRendering(nextEvent.content, linkRenderContext)
              .trim() ===
            normalizedContent
        ) {
          continue;
        }

        const previousEvent = i > 0 ? events[i - 1] : undefined;
        if (
          previousEvent?.kind === "message.assistant" &&
          previousEvent.turnId === event.turnId &&
          applyMarkdownLinkRendering(
              previousEvent.content,
              linkRenderContext,
            )
              .trim() === normalizedContent
        ) {
          const keepFinalOverCommentary =
            previousEvent.phase === "commentary" &&
            event.phase === "final";
          if (!keepFinalOverCommentary) {
            continue;
          }
        }
      }

      const signature = makeEventSignature(event);
      if (signature === lastSignature) {
        continue;
      }
      lastSignature = signature;

      const includeHeading = event.kind !== lastRole;
      lastRole = event.kind;

      const messageParts: string[] = [];
      if (includeHeading) {
        messageParts.push(
          formatMessageHeading(
            event,
            options.speakerNames,
            options.headingTimestampTimezone,
          ),
          "",
        );
      }
      messageParts.push(renderedContent);
      parts.push(messageParts.join("\n"), "");
    } else if (event.kind === "tool.call") {
      if (!includeToolCalls) continue;

      const callParts: string[] = [
        `# ${lastAssistantSpeaker}_${
          formatHeadingTimestamp(
            event.timestamp,
            options.headingTimestampTimezone,
          )
        }_Tool-${event.name}`,
      ];
      if (event.description?.trim().length) {
        callParts.push(
          "",
          applyMarkdownLinkRendering(event.description, linkRenderContext),
        );
      }
      parts.push(callParts.join("\n"), "");
      lastSignature = undefined;
    } else if (event.kind === "tool.result") {
      if (!includeToolResults) {
        continue;
      }

      const resultContent = event.result.trim();
      if (resultContent.length === 0) {
        continue;
      }
      const resultParts = [
        "",
        "<details>",
        `<summary>Tool result: ${event.toolCallId}</summary>`,
        "",
        "```",
        truncate(event.result, truncateToolResults),
        "```",
        "",
        "</details>",
      ];
      parts.push(resultParts.join("\n"), "");
      lastSignature = undefined;
      continue;
    } else if (event.kind === "thinking") {
      if (!includeThinking) continue;
      const thinkingContent = applyMarkdownLinkRendering(
        event.content.trim(),
        linkRenderContext,
      );
      if (thinkingContent.length === 0) continue;
      parts.push(thinkingContent, "");
      lastSignature = undefined;
    } else if (event.kind === "decision") {
      const metadata = typeof event.metadata === "object" &&
          event.metadata !== null
        ? event.metadata as Record<string, unknown>
        : undefined;
      const providerQuestionId = String(metadata?.["providerQuestionId"] ?? "")
        .trim();
      const parsedOptionLines = parseQuestionnaireOptionLines(
        metadata,
        linkRenderContext,
      );
      const questionnaireDecision = providerQuestionId.length > 0 ||
        parsedOptionLines.length > 0;
      const questionnaireAcceptedDecision = questionnaireDecision &&
        event.status === "accepted";
      const questionnaireProposedDecision = questionnaireDecision &&
        event.status === "proposed";

      if (questionnaireAcceptedDecision || questionnaireProposedDecision) {
        if (questionnaireAcceptedDecision && !includeDecisionSelection) {
          continue;
        }
        if (
          questionnaireProposedDecision &&
          !includeDecisionPrompt &&
          !includeDecisionOptions
        ) {
          continue;
        }

        const styledSummary = applyMarkdownLinkRendering(
          event.summary,
          linkRenderContext,
        );
        const parsedSummary = questionnaireAcceptedDecision
          ? splitAcceptedDecisionSummary(styledSummary)
          : { prompt: styledSummary.trim() };
        const contextKeys = new Set<string>();
        const decisionKeyContext = normalizeDecisionContextKey(
          event.decisionKey,
        );
        if (decisionKeyContext) contextKeys.add(decisionKeyContext);
        const providerQuestionIdContext = normalizeDecisionContextKey(
          providerQuestionId,
        );
        if (providerQuestionIdContext) {
          contextKeys.add(providerQuestionIdContext);
        }
        const promptContext = normalizeDecisionContextKey(parsedSummary.prompt);
        if (promptContext) contextKeys.add(promptContext);

        let storedPrompt: string | undefined;
        let storedOptionLines: string[] = [];
        for (const key of contextKeys) {
          const existing = questionnaireContextByKey.get(key);
          if (!existing) continue;
          if (!storedPrompt && existing.prompt) {
            storedPrompt = existing.prompt;
          }
          if (
            storedOptionLines.length === 0 && existing.optionLines.length > 0
          ) {
            storedOptionLines = existing.optionLines;
          }
        }

        const prompt = parsedSummary.prompt && parsedSummary.prompt.length > 0
          ? parsedSummary.prompt
          : storedPrompt;
        const optionLines = parsedOptionLines.length > 0
          ? parsedOptionLines
          : storedOptionLines;
        const selection = questionnaireAcceptedDecision
          ? (parsedSummary.selection && parsedSummary.selection.length > 0
            ? parsedSummary.selection
            : styledSummary.trim())
          : undefined;

        if (contextKeys.size > 0 && (prompt || optionLines.length > 0)) {
          for (const key of contextKeys) {
            questionnaireContextByKey.set(key, {
              prompt,
              optionLines,
            });
          }
        }

        const decisionHeading = `# ${lastAssistantSpeaker}_${
          formatHeadingTimestamp(
            event.timestamp,
            options.headingTimestampTimezone,
          )
        }_Tool-decision-${resolveDecisionHeadingSegment(event.decisionKey)}`;
        const decisionParts = [decisionHeading];
        if (includeDecisionPrompt && prompt && prompt.length > 0) {
          decisionParts.push("", "## Prompt", "", prompt);
        }
        if (includeDecisionOptions && optionLines.length > 0) {
          decisionParts.push("", "## Options", "", ...optionLines);
        }
        if (
          questionnaireAcceptedDecision &&
          includeDecisionSelection &&
          selection &&
          selection.length > 0
        ) {
          decisionParts.push("", "## User Selection", "", selection);
        }
        if (decisionParts.length === 1) {
          continue;
        }
        parts.push(decisionParts.join("\n"), "");
        lastSignature = undefined;
        continue;
      }

      const includeNonQuestionnaireDecision = event.status === "accepted"
        ? includeDecisionSelection
        : includeDecisionPrompt;
      if (!includeNonQuestionnaireDecision) {
        continue;
      }
      const decisionParts = [
        "",
        `**Decision [${event.decisionKey}]:** ${
          applyMarkdownLinkRendering(event.summary, linkRenderContext)
        }`,
        `*Status: ${event.status} — decided by: ${event.decidedBy}*`,
      ];
      parts.push(decisionParts.join("\n"), "");
      lastSignature = undefined;
    } else if (event.kind === "provider.info") {
      if (!includeSystemEvents) continue;
      const infoParts = [
        "",
        `> [provider.info${event.subtype ? `:${event.subtype}` : ""}] ${
          applyMarkdownLinkRendering(event.content, linkRenderContext)
        }`,
      ];
      parts.push(infoParts.join("\n"), "");
      lastSignature = undefined;
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

interface ExistingFrontmatterView {
  frontmatter: string;
  body: string;
}

function splitExistingFrontmatter(
  content: string,
): ExistingFrontmatterView | null {
  if (!content.startsWith("---\n")) {
    return null;
  }

  const closingIndex = content.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return null;
  }

  const frontmatterEnd = closingIndex + 4;
  let body = content.slice(frontmatterEnd);
  if (body.startsWith("\n\n")) {
    body = body.slice(2);
  } else if (body.startsWith("\n")) {
    body = body.slice(1);
  }

  return {
    frontmatter: content.slice(0, frontmatterEnd),
    body,
  };
}

async function extractExistingFrontmatter(
  filePath: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }

  const split = splitExistingFrontmatter(content);
  if (!split) {
    return null;
  }
  return split.frontmatter;
}

async function readExistingFile(
  filePath: string,
): Promise<{ exists: boolean; content: string }> {
  try {
    const content = await Deno.readTextFile(filePath);
    return { exists: true, content };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

async function writeTextFileCreateNew(
  filePath: string,
  content: string,
): Promise<void> {
  const file = await Deno.open(filePath, {
    write: true,
    createNew: true,
  });
  try {
    const buffer = new TextEncoder().encode(content);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesWritten = await file.write(buffer.subarray(offset));
      if (bytesWritten <= 0) {
        throw new Error(
          `Unable to write all bytes for ${filePath}; write() returned ${bytesWritten}`,
        );
      }
      offset += bytesWritten;
    }
  } finally {
    file.close();
  }
}

async function resolveRenderOptionsForOutputPath(
  outputPath: string,
  options: MarkdownRenderOptions,
): Promise<MarkdownRenderOptions> {
  const renderOutputPath = options.renderOutputPath ?? outputPath;
  if (options.markdownLinkStyle !== "dendron-wikilink") {
    return {
      ...options,
      renderOutputPath,
    };
  }
  if (options.wikilinkifiableRoots !== undefined) {
    return {
      ...options,
      renderOutputPath,
      wikilinkifiableRoots: [...options.wikilinkifiableRoots],
    };
  }

  const dendronContext = await resolveDendronWikilinkContext(renderOutputPath);
  return {
    ...options,
    renderOutputPath,
    wikilinkifiableRoots: dendronContext.wikilinkifiableRoots,
  };
}

export class MarkdownConversationWriter implements ConversationWriterLike {
  async appendEvents(
    outputPath: string,
    events: ConversationEvent[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });
    const baseRenderOptions = await resolveRenderOptionsForOutputPath(
      outputPath,
      options,
    );

    let existing = await readExistingFile(outputPath);
    if (options.requireCreateNew && existing.exists) {
      throw new Deno.errors.AlreadyExists(
        `Capture destination already exists: ${outputPath}`,
      );
    }
    const includeFrontmatter = options.includeFrontmatter !== false;
    if (!existing.exists) {
      const title = options.title ?? basename(outputPath, ".md");
      const rendered = renderEventsToMarkdown(events, {
        ...baseRenderOptions,
        includeFrontmatter,
        title,
      });
      const content = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
      try {
        await writeTextFileCreateNew(outputPath, content);
        return {
          mode: "create",
          outputPath,
          wrote: true,
          deduped: false,
        };
      } catch (error) {
        if (
          !(error instanceof Deno.errors.AlreadyExists) ||
          options.requireCreateNew
        ) {
          throw error;
        }
        existing = await readExistingFile(outputPath);
      }
    }

    const existingFrontmatterView = splitExistingFrontmatter(existing.content);
    const shouldMergeFrontmatter = existingFrontmatterView &&
      ((options.frontmatterSessionIds?.length ?? 0) > 0 ||
        (options.frontmatterWorkspaceIds?.length ?? 0) > 0 ||
        (options.frontmatterRecordingCycleIds?.length ?? 0) > 0 ||
        (options.frontmatterParticipants?.length ?? 0) > 0 ||
        (options.frontmatterTags?.length ?? 0) > 0 ||
        (options.frontmatterConversationEventKinds?.length ?? 0) > 0);
    const nextFrontmatter = shouldMergeFrontmatter
      ? mergeAccretiveFrontmatterFields({
        frontmatter: existingFrontmatterView.frontmatter,
        sessionIds: options.frontmatterSessionIds,
        workspaceIds: options.frontmatterWorkspaceIds,
        recordingCycleIds: options.frontmatterRecordingCycleIds,
        participants: options.frontmatterParticipants,
        tags: options.frontmatterTags,
        conversationEventKinds: options.frontmatterConversationEventKinds,
      })
      : existingFrontmatterView?.frontmatter;
    const frontmatterChanged = existingFrontmatterView !== null &&
      nextFrontmatter !== undefined &&
      nextFrontmatter !== existingFrontmatterView.frontmatter;

    const rendered = renderEventsToMarkdown(events, {
      ...baseRenderOptions,
      includeFrontmatter: false,
    });
    const content = rendered.trim();
    const hasBodyToAppend = content.length > 0;
    if (!hasBodyToAppend && !frontmatterChanged) {
      return {
        mode: "append",
        outputPath,
        wrote: false,
        deduped: false,
      };
    }

    const existingBody = existingFrontmatterView?.body ?? existing.content;
    const existingTrimmed = existing.content.trimEnd();
    const deduped = hasBodyToAppend && existingTrimmed.endsWith(content);
    if (deduped && !frontmatterChanged) {
      return {
        mode: "append",
        outputPath,
        wrote: false,
        deduped: true,
      };
    }

    if (frontmatterChanged && existingFrontmatterView && nextFrontmatter) {
      let nextBody = existingBody;
      if (hasBodyToAppend && !deduped) {
        const separator = nextBody.length === 0
          ? ""
          : nextBody.endsWith("\n\n")
          ? ""
          : nextBody.endsWith("\n")
          ? "\n"
          : "\n\n";
        nextBody = `${nextBody}${separator}${content}`;
      }
      const normalizedBody = nextBody.replace(/^\n+/, "");
      const nextContent = normalizedBody.length > 0
        ? `${nextFrontmatter}\n\n${
          normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`
        }`
        : `${nextFrontmatter}\n`;
      await Deno.writeTextFile(outputPath, nextContent);
    } else if (hasBodyToAppend && !deduped) {
      const separator = existing.content.length === 0
        ? ""
        : existing.content.endsWith("\n\n")
        ? ""
        : existing.content.endsWith("\n")
        ? "\n"
        : "\n\n";
      await Deno.writeTextFile(outputPath, `${separator}${content}`, {
        append: true,
        create: true,
      });
    }

    return {
      mode: "append",
      outputPath,
      wrote: frontmatterChanged || (hasBodyToAppend && !deduped),
      deduped,
    };
  }

  async overwriteEvents(
    outputPath: string,
    events: ConversationEvent[],
    options: MarkdownRenderOptions = {},
  ): Promise<MarkdownWriteResult> {
    await Deno.mkdir(dirname(outputPath), { recursive: true });
    const baseRenderOptions = await resolveRenderOptionsForOutputPath(
      outputPath,
      options,
    );

    const existingFrontmatter = await extractExistingFrontmatter(outputPath);
    if (existingFrontmatter) {
      const hasAccretiveInputs = (options.frontmatterSessionIds?.length ?? 0) >
          0 ||
        (options.frontmatterWorkspaceIds?.length ?? 0) > 0 ||
        (options.frontmatterRecordingCycleIds?.length ?? 0) > 0 ||
        (options.frontmatterParticipants?.length ?? 0) > 0 ||
        (options.frontmatterTags?.length ?? 0) > 0 ||
        (options.frontmatterConversationEventKinds?.length ?? 0) > 0;
      const mergedFrontmatter = hasAccretiveInputs
        ? mergeAccretiveFrontmatterFields({
          frontmatter: existingFrontmatter,
          sessionIds: options.frontmatterSessionIds,
          workspaceIds: options.frontmatterWorkspaceIds,
          recordingCycleIds: options.frontmatterRecordingCycleIds,
          participants: options.frontmatterParticipants,
          tags: options.frontmatterTags,
          conversationEventKinds: options.frontmatterConversationEventKinds,
        })
        : existingFrontmatter;
      const body = renderEventsToMarkdown(events, {
        ...baseRenderOptions,
        includeFrontmatter: false,
      }).trim();
      const content = body.length > 0
        ? `${mergedFrontmatter}\n\n${body}\n`
        : `${mergedFrontmatter}\n`;
      await Deno.writeTextFile(outputPath, content);
      return {
        mode: "overwrite",
        outputPath,
        wrote: true,
        deduped: false,
      };
    }

    const title = options.title ?? basename(outputPath, ".md");
    const includeFrontmatter = options.includeFrontmatter !== false;
    const rendered = renderEventsToMarkdown(events, {
      ...baseRenderOptions,
      includeFrontmatter,
      title,
    });
    const content = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
    await Deno.writeTextFile(outputPath, content);
    return {
      mode: "overwrite",
      outputPath,
      wrote: true,
      deduped: false,
    };
  }
}
