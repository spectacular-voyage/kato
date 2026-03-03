function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isRecordValue(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined)
      .sort();
    return `{${
      keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(String(value));
}

const FNV1A64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function hashStringFNV1a(value: string): string {
  let hash = FNV1A64_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV1A64_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
