const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function parseTimestampDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function getTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = timestampFormatters.get(timeZone);
  if (existing) {
    return existing;
  }
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    hour12: false,
  });
  timestampFormatters.set(timeZone, created);
  return created;
}

function formatTimestampParts(date: Date, timeZone: string): string {
  const formatter = getTimestampFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")} ${
    values.get("hour")
  }:${values.get("minute")}:${values.get("second")}`;
}

export function canonicalTimestamp(
  value: string | undefined,
): string | undefined {
  const parsed = parseTimestampDate(value);
  return parsed?.toISOString();
}

export function formatTimestamp(
  value: string | undefined,
  options: { timeZone?: string } = {},
): string {
  if (!value) {
    return "n/a";
  }
  const parsed = parseTimestampDate(value);
  if (!parsed) {
    return value;
  }
  if (!options.timeZone) {
    return parsed.toISOString();
  }
  try {
    return formatTimestampParts(parsed, options.timeZone);
  } catch {
    return parsed.toISOString();
  }
}

export function parseTimestampMs(
  value: string | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function formatRelativeTimestamp(
  value: string | undefined,
  nowMs: number,
): string {
  if (!value) {
    return "n/a";
  }
  const timestamp = parseTimestampMs(value);
  if (timestamp === undefined) {
    return value;
  }
  const diffSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m ago`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h ago`;
  }
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}
