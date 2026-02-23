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

function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderFrontmatter(options: {
  title: string;
  now?: Date;
  makeFrontmatterId?: (title: string) => string;
}): string {
  const now = options.now ?? new Date();
  const frontmatterId = options.makeFrontmatterId
    ? options.makeFrontmatterId(options.title)
    : makeCompactFrontmatterId(options.title);
  const timestampMs = now.getTime();

  return [
    "---",
    `id: ${frontmatterId}`,
    `title: ${quoteYaml(options.title)}`,
    "desc: ''",
    `created: ${timestampMs}`,
    `updated: ${timestampMs}`,
    "---",
  ].join("\n");
}
