import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

const DEFAULT_MAX_SLUG_LENGTH = 24;
const DEFAULT_RANDOM_SUFFIX_LENGTH = 6;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KATO_SESSION_IDS_KEY = "kato-sessionIds";
const KATO_WORKSPACE_IDS_KEY = "kato-workspaceIds";
const KATO_RECORDING_IDS_KEY = "kato-recordingIds";
export const KATO_WRITER_FEATURE_FLAGS_KEY = "kato-writerFeatureFlags";

// Descriptive snapshot of the effective render policy for an output. Unlike
// the accretive id/tag lists, it is replaced wholesale on update and never
// drives live Kato behavior.
export interface FrontmatterWriterPolicy {
  writerIncludeCommentary: boolean;
  writerIncludeThinking: boolean;
}

export function slugifyForFrontmatterId(
  value: string,
  maxLength = DEFAULT_MAX_SLUG_LENGTH,
): string {
  const cleaned = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const trimmed = cleaned.slice(0, maxLength).replace(/-+$/g, "");
  return trimmed.length > 0 ? trimmed : "note";
}

function randomAlphaNumeric(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]!,
  ).join("");
}

export function makeCompactFrontmatterId(title: string): string {
  const slug = slugifyForFrontmatterId(title);
  const suffix = randomAlphaNumeric(DEFAULT_RANDOM_SUFFIX_LENGTH);
  return `${slug}-${suffix}`;
}

function normalizeFrontmatterScopeShortId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

function makeRecordingScopedFrontmatterId(
  title: string,
  recordingCycleId: string,
): string {
  const slug = slugifyForFrontmatterId(title);
  const recordingShortId = normalizeFrontmatterScopeShortId(recordingCycleId);
  if (recordingShortId.length === 0) {
    return makeCompactFrontmatterId(title);
  }
  return `${slug}-${recordingShortId}`;
}

export function makeSessionScopedFrontmatterId(
  title: string,
  sessionId: string,
): string {
  const slug = slugifyForFrontmatterId(title);
  const sessionShortId = normalizeFrontmatterScopeShortId(sessionId);
  if (sessionShortId.length === 0) {
    return makeCompactFrontmatterId(title);
  }
  return `${slug}-${sessionShortId}`;
}

function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SAFE_INLINE_YAML_SCALAR = /^[A-Za-z0-9._/@:-]+$/;

function isAmbiguousYamlScalar(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseYaml(value);
  } catch {
    return false;
  }
  return typeof parsed !== "string";
}

function formatInlineYamlScalar(value: string): string {
  if (value.length === 0) {
    return quoteYaml(value);
  }
  const hasEdgeWhitespace = value !== value.trim();
  if (
    !hasEdgeWhitespace &&
    SAFE_INLINE_YAML_SCALAR.test(value) &&
    !isAmbiguousYamlScalar(value)
  ) {
    return value;
  }
  return quoteYaml(value);
}

function renderInlineYamlArray(values: string[]): string {
  return `[${values.map((value) => formatInlineYamlScalar(value)).join(", ")}]`;
}

function dedupeStrings(values: ReadonlyArray<string> | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}

export function renderFrontmatter(options: {
  title: string;
  now?: Date;
  makeFrontmatterId?: (title: string) => string;
  sessionIds?: string[];
  workspaceIds?: string[];
  recordingCycleIds?: string[];
  participants?: string[];
  tags?: string[];
  conversationEventKinds?: string[];
  writerPolicy?: FrontmatterWriterPolicy;
  includeUpdated?: boolean;
}): string {
  const now = options.now ?? new Date();
  const sessionIds = dedupeStrings(options.sessionIds);
  const workspaceIds = dedupeStrings(options.workspaceIds);
  const recordingCycleIds = dedupeStrings(options.recordingCycleIds);
  const frontmatterRecordingCycleId = recordingCycleIds[0];
  const frontmatterSessionId = sessionIds[0];
  const frontmatterId = options.makeFrontmatterId
    ? options.makeFrontmatterId(options.title)
    : frontmatterRecordingCycleId
    ? makeRecordingScopedFrontmatterId(
      options.title,
      frontmatterRecordingCycleId,
    )
    : frontmatterSessionId
    ? makeSessionScopedFrontmatterId(options.title, frontmatterSessionId)
    : makeCompactFrontmatterId(options.title);
  const timestampMs = now.getTime();
  const includeUpdated = options.includeUpdated ?? true;
  const participants = dedupeStrings(options.participants);
  const tags = dedupeStrings(options.tags);
  const conversationEventKinds = dedupeStrings(options.conversationEventKinds);

  const lines = [
    "---",
    `id: ${frontmatterId}`,
    `title: ${quoteYaml(options.title)}`,
    "desc: ''",
    `created: ${timestampMs}`,
    ...(includeUpdated ? [`updated: ${timestampMs}`] : []),
    ...(participants.length > 0
      ? [`participants: ${renderInlineYamlArray(participants)}`]
      : []),
    ...(sessionIds.length > 0
      ? [`${KATO_SESSION_IDS_KEY}: ${renderInlineYamlArray(sessionIds)}`]
      : []),
    ...(workspaceIds.length > 0
      ? [`${KATO_WORKSPACE_IDS_KEY}: ${renderInlineYamlArray(workspaceIds)}`]
      : []),
    ...(recordingCycleIds.length > 0
      ? [
        `${KATO_RECORDING_IDS_KEY}: ${
          renderInlineYamlArray(recordingCycleIds)
        }`,
      ]
      : []),
    ...(tags.length > 0 ? [`tags: ${renderInlineYamlArray(tags)}`] : []),
    ...(conversationEventKinds.length > 0
      ? [
        `conversationEventKinds: ${
          renderInlineYamlArray(conversationEventKinds)
        }`,
      ]
      : []),
    ...(options.writerPolicy
      ? [
        `${KATO_WRITER_FEATURE_FLAGS_KEY}:`,
        `  writerIncludeCommentary: ${options.writerPolicy.writerIncludeCommentary}`,
        `  writerIncludeThinking: ${options.writerPolicy.writerIncludeThinking}`,
      ]
      : []),
    "---",
  ];

  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderYamlValue(key: string, value: unknown): string[] {
  if (typeof value === "string") {
    return [`${key}: ${formatInlineYamlScalar(value)}`];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [`${key}: ${String(value)}`];
  }
  if (value === null) {
    return [`${key}: null`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${key}: []`];
    }
    const allStrings = value.every((item) => typeof item === "string");
    if (allStrings) {
      const values = value as string[];
      return [`${key}: ${renderInlineYamlArray(values)}`];
    }
    const serialized = stringifyYaml(value).trimEnd();
    if (!serialized.includes("\n")) {
      return [`${key}: ${serialized}`];
    }
    return [
      `${key}:`,
      ...serialized.split("\n").map((line) => `  ${line}`),
    ];
  }
  if (isRecord(value)) {
    const serialized = stringifyYaml(value).trimEnd();
    if (serialized.length === 0) {
      return [`${key}: {}`];
    }
    if (!serialized.includes("\n")) {
      return [`${key}: ${serialized}`];
    }
    return [
      `${key}:`,
      ...serialized.split("\n").map((line) => `  ${line}`),
    ];
  }
  return [`${key}: ${formatInlineYamlScalar(String(value))}`];
}

function renderFrontmatterRecord(record: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(record)) {
    lines.push(...renderYamlValue(key, value));
  }
  lines.push("---");
  return lines.join("\n");
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function mergeStringLists(existing: string[], incoming: string[]): string[] {
  const deduped = new Set<string>();
  for (const item of existing) {
    const normalized = item.trim();
    if (normalized.length > 0) {
      deduped.add(normalized);
    }
  }
  for (const item of incoming) {
    const normalized = item.trim();
    if (normalized.length > 0) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function mergeAccretiveFrontmatterFields(options: {
  frontmatter: string;
  sessionIds?: ReadonlyArray<string>;
  workspaceIds?: ReadonlyArray<string>;
  recordingCycleIds?: ReadonlyArray<string>;
  participants?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  conversationEventKinds?: ReadonlyArray<string>;
}): string {
  const incomingSessionIds = dedupeStrings(options.sessionIds);
  const incomingWorkspaceIds = dedupeStrings(options.workspaceIds);
  const incomingRecordingCycleIds = dedupeStrings(options.recordingCycleIds);
  const incomingParticipants = dedupeStrings(options.participants);
  const incomingTags = dedupeStrings(options.tags);
  const incomingConversationEventKinds = dedupeStrings(
    options.conversationEventKinds,
  );
  if (
    incomingSessionIds.length === 0 &&
    incomingWorkspaceIds.length === 0 &&
    incomingRecordingCycleIds.length === 0 &&
    incomingParticipants.length === 0 &&
    incomingTags.length === 0 &&
    incomingConversationEventKinds.length === 0
  ) {
    return options.frontmatter;
  }
  if (!options.frontmatter.startsWith("---\n")) {
    return options.frontmatter;
  }
  const closingIndex = options.frontmatter.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return options.frontmatter;
  }
  const payload = options.frontmatter.slice(4, closingIndex);
  let parsed: unknown;
  try {
    parsed = parseYaml(payload);
  } catch {
    return options.frontmatter;
  }
  if (!isRecord(parsed)) {
    return options.frontmatter;
  }

  const existingSessionIds = readStringList(parsed[KATO_SESSION_IDS_KEY]);
  const existingWorkspaceIds = readStringList(parsed[KATO_WORKSPACE_IDS_KEY]);
  const existingRecordingCycleIds = readStringList(
    parsed[KATO_RECORDING_IDS_KEY],
  );
  const existingParticipants = readStringList(parsed["participants"]);
  const existingTags = readStringList(parsed["tags"]);
  const existingConversationEventKinds = readStringList(
    parsed["conversationEventKinds"],
  );
  const mergedSessionIds = mergeStringLists(
    existingSessionIds,
    incomingSessionIds,
  );
  const mergedWorkspaceIds = mergeStringLists(
    existingWorkspaceIds,
    incomingWorkspaceIds,
  );
  const mergedRecordingCycleIds = mergeStringLists(
    existingRecordingCycleIds,
    incomingRecordingCycleIds,
  );
  const mergedParticipants = mergeStringLists(
    existingParticipants,
    incomingParticipants,
  );
  const mergedTags = mergeStringLists(existingTags, incomingTags);
  const mergedConversationEventKinds = mergeStringLists(
    existingConversationEventKinds,
    incomingConversationEventKinds,
  );

  const sessionIdsChanged = incomingSessionIds.length > 0 &&
    !arraysEqual(existingSessionIds, mergedSessionIds);
  const workspaceIdsChanged = incomingWorkspaceIds.length > 0 &&
    !arraysEqual(existingWorkspaceIds, mergedWorkspaceIds);
  const recordingCycleIdsChanged = incomingRecordingCycleIds.length > 0 &&
    !arraysEqual(existingRecordingCycleIds, mergedRecordingCycleIds);
  const participantsChanged = incomingParticipants.length > 0 &&
    !arraysEqual(existingParticipants, mergedParticipants);
  const tagsChanged = incomingTags.length > 0 &&
    !arraysEqual(existingTags, mergedTags);
  const conversationEventKindsChanged =
    incomingConversationEventKinds.length > 0 &&
    !arraysEqual(
      existingConversationEventKinds,
      mergedConversationEventKinds,
    );
  if (
    !sessionIdsChanged &&
    !workspaceIdsChanged &&
    !recordingCycleIdsChanged &&
    !participantsChanged &&
    !tagsChanged &&
    !conversationEventKindsChanged
  ) {
    return options.frontmatter;
  }

  const nextRecord: Record<string, unknown> = { ...parsed };
  if (sessionIdsChanged) {
    nextRecord[KATO_SESSION_IDS_KEY] = mergedSessionIds;
  }
  if (workspaceIdsChanged) {
    nextRecord[KATO_WORKSPACE_IDS_KEY] = mergedWorkspaceIds;
  }
  if (recordingCycleIdsChanged) {
    nextRecord[KATO_RECORDING_IDS_KEY] = mergedRecordingCycleIds;
  }
  if (participantsChanged) {
    nextRecord["participants"] = mergedParticipants;
  }
  if (tagsChanged) {
    if (mergedTags.length > 0) {
      nextRecord["tags"] = mergedTags;
    } else {
      delete nextRecord["tags"];
    }
  }
  if (conversationEventKindsChanged) {
    nextRecord["conversationEventKinds"] = mergedConversationEventKinds;
  }
  return renderFrontmatterRecord(nextRecord);
}

function readFrontmatterWriterPolicy(
  value: unknown,
): FrontmatterWriterPolicy | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const commentary = value["writerIncludeCommentary"];
  const thinking = value["writerIncludeThinking"];
  if (typeof commentary !== "boolean" || typeof thinking !== "boolean") {
    return undefined;
  }
  return {
    writerIncludeCommentary: commentary,
    writerIncludeThinking: thinking,
  };
}

function writerPolicyEquals(
  a: FrontmatterWriterPolicy | undefined,
  b: FrontmatterWriterPolicy,
): boolean {
  return a !== undefined &&
    a.writerIncludeCommentary === b.writerIncludeCommentary &&
    a.writerIncludeThinking === b.writerIncludeThinking;
}

// Replaces the effective writer-policy snapshot in an existing frontmatter
// block. Returns the input unchanged when the snapshot already matches or the
// frontmatter cannot be parsed.
export function mergeFrontmatterWriterPolicySnapshot(options: {
  frontmatter: string;
  writerPolicy: FrontmatterWriterPolicy;
}): string {
  if (!options.frontmatter.startsWith("---\n")) {
    return options.frontmatter;
  }
  const closingIndex = options.frontmatter.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return options.frontmatter;
  }
  const payload = options.frontmatter.slice(4, closingIndex);
  let parsed: unknown;
  try {
    parsed = parseYaml(payload);
  } catch {
    return options.frontmatter;
  }
  if (!isRecord(parsed)) {
    return options.frontmatter;
  }
  const existingPolicy = readFrontmatterWriterPolicy(
    parsed[KATO_WRITER_FEATURE_FLAGS_KEY],
  );
  if (writerPolicyEquals(existingPolicy, options.writerPolicy)) {
    return options.frontmatter;
  }
  const nextRecord: Record<string, unknown> = { ...parsed };
  nextRecord[KATO_WRITER_FEATURE_FLAGS_KEY] = {
    writerIncludeCommentary: options.writerPolicy.writerIncludeCommentary,
    writerIncludeThinking: options.writerPolicy.writerIncludeThinking,
  };
  return renderFrontmatterRecord(nextRecord);
}

export interface FrontmatterMetadataUpdate {
  title?: string;
  tags?: ReadonlyArray<string>;
  replaceTags?: ReadonlyArray<string>;
  writerPolicy?: FrontmatterWriterPolicy;
}

export interface FrontmatterMetadataUpdateResult {
  content: string;
  changed: boolean;
  hadFrontmatter: boolean;
}

// Metadata-only frontmatter update on full markdown file content: replaces
// `title` and the writer-policy snapshot, merges `tags` accretively unless
// `replaceTags` is present, and preserves the body bytes untouched. Content
// without parseable frontmatter is returned unchanged.
export function updateFrontmatterMetadataFields(
  content: string,
  update: FrontmatterMetadataUpdate,
): FrontmatterMetadataUpdateResult {
  if (!content.startsWith("---\n")) {
    return { content, changed: false, hadFrontmatter: false };
  }
  const closingIndex = content.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return { content, changed: false, hadFrontmatter: false };
  }
  const frontmatterEnd = closingIndex + 4;
  const payload = content.slice(4, closingIndex);
  const body = content.slice(frontmatterEnd);
  let parsed: unknown;
  try {
    parsed = parseYaml(payload);
  } catch {
    return { content, changed: false, hadFrontmatter: false };
  }
  if (!isRecord(parsed)) {
    return { content, changed: false, hadFrontmatter: false };
  }

  const nextRecord: Record<string, unknown> = { ...parsed };
  let changed = false;

  const nextTitle = update.title?.trim();
  if (nextTitle && parsed["title"] !== nextTitle) {
    nextRecord["title"] = nextTitle;
    changed = true;
  }

  const incomingTags = dedupeStrings(update.tags);
  if (incomingTags.length > 0) {
    const existingTags = readStringList(parsed["tags"]);
    const mergedTags = mergeStringLists(existingTags, incomingTags);
    if (!arraysEqual(existingTags, mergedTags)) {
      nextRecord["tags"] = mergedTags;
      changed = true;
    }
  }
  if (update.replaceTags !== undefined) {
    const existingTags = readStringList(parsed["tags"]);
    const replacementTags = dedupeStrings(update.replaceTags);
    if (!arraysEqual(existingTags, replacementTags)) {
      if (replacementTags.length > 0) {
        nextRecord["tags"] = replacementTags;
      } else {
        delete nextRecord["tags"];
      }
      changed = true;
    }
  }

  if (update.writerPolicy) {
    const existingPolicy = readFrontmatterWriterPolicy(
      parsed[KATO_WRITER_FEATURE_FLAGS_KEY],
    );
    if (!writerPolicyEquals(existingPolicy, update.writerPolicy)) {
      nextRecord[KATO_WRITER_FEATURE_FLAGS_KEY] = {
        writerIncludeCommentary: update.writerPolicy.writerIncludeCommentary,
        writerIncludeThinking: update.writerPolicy.writerIncludeThinking,
      };
      changed = true;
    }
  }

  if (!changed) {
    return { content, changed: false, hadFrontmatter: true };
  }
  return {
    content: `${renderFrontmatterRecord(nextRecord)}${body}`,
    changed: true,
    hadFrontmatter: true,
  };
}
