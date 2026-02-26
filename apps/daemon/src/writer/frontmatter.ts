import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

const DEFAULT_MAX_SLUG_LENGTH = 24;
const DEFAULT_RANDOM_SUFFIX_LENGTH = 6;
const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

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

function normalizeSessionShortId(sessionId: string): string {
  return sessionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
}

export function makeSessionScopedFrontmatterId(
  title: string,
  sessionId: string,
): string {
  const slug = slugifyForFrontmatterId(title);
  const sessionShortId = normalizeSessionShortId(sessionId);
  if (sessionShortId.length === 0) {
    return makeCompactFrontmatterId(title);
  }
  return `${slug}-${sessionShortId}`;
}

function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatInlineYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return quoteYaml(trimmed);
  }
  if (/^[A-Za-z0-9._/@:-]+$/.test(trimmed)) {
    return trimmed;
  }
  return quoteYaml(trimmed);
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
  sessionId?: string;
  recordingIds?: string[];
  participants?: string[];
  tags?: string[];
  includeUpdated?: boolean;
}): string {
  const now = options.now ?? new Date();
  const sessionId = options.sessionId?.trim();
  const frontmatterId = options.makeFrontmatterId
    ? options.makeFrontmatterId(options.title)
    : sessionId
    ? makeSessionScopedFrontmatterId(options.title, sessionId)
    : makeCompactFrontmatterId(options.title);
  const timestampMs = now.getTime();
  const includeUpdated = options.includeUpdated ?? true;
  const participants = dedupeStrings(options.participants);
  const recordingIds = dedupeStrings(options.recordingIds);
  const tags = dedupeStrings(options.tags);

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
    ...(sessionId ? [`sessionId: ${formatInlineYamlScalar(sessionId)}`] : []),
    ...(recordingIds.length > 0
      ? [`recordingIds: ${renderInlineYamlArray(recordingIds)}`]
      : []),
    ...(tags.length > 0 ? [`tags: ${renderInlineYamlArray(tags)}`] : []),
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
  recordingIds?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
}): string {
  const incomingRecordingIds = dedupeStrings(options.recordingIds);
  const incomingTags = dedupeStrings(options.tags);
  if (incomingRecordingIds.length === 0 && incomingTags.length === 0) {
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

  const existingRecordingIds = readStringList(parsed["recordingIds"]);
  const existingTags = readStringList(parsed["tags"]);
  const mergedRecordingIds = mergeStringLists(
    existingRecordingIds,
    incomingRecordingIds,
  );
  const mergedTags = mergeStringLists(existingTags, incomingTags);

  const recordingIdsChanged = incomingRecordingIds.length > 0 &&
    !arraysEqual(existingRecordingIds, mergedRecordingIds);
  const tagsChanged = incomingTags.length > 0 &&
    !arraysEqual(existingTags, mergedTags);
  if (!recordingIdsChanged && !tagsChanged) {
    return options.frontmatter;
  }

  const nextRecord: Record<string, unknown> = { ...parsed };
  if (recordingIdsChanged) {
    nextRecord["recordingIds"] = mergedRecordingIds;
  }
  if (tagsChanged) {
    nextRecord["tags"] = mergedTags;
  }
  return renderFrontmatterRecord(nextRecord);
}
