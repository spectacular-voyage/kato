export interface CodexSessionMeta {
  id: string;
  source: string;
  parentProviderSessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseCodexSessionMetaLine(
  firstLine: string,
): CodexSessionMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed["type"] !== "session_meta") {
    return undefined;
  }
  const payload = parsed["payload"];
  if (!isRecord(payload)) {
    return undefined;
  }
  const id = nonEmptyString(payload["id"]);
  if (!id) {
    return undefined;
  }

  const sourceValue = payload["source"];
  const source = nonEmptyString(sourceValue) ?? "";
  let parentProviderSessionId: string | undefined;
  if (payload["thread_source"] === "subagent" && isRecord(sourceValue)) {
    const subagent = sourceValue["subagent"];
    const threadSpawn = isRecord(subagent) ? subagent["thread_spawn"] : null;
    if (isRecord(threadSpawn)) {
      parentProviderSessionId = nonEmptyString(
        threadSpawn["parent_thread_id"],
      );
    }
  }

  return {
    id,
    source,
    ...(parentProviderSessionId ? { parentProviderSessionId } : {}),
  };
}

async function readFirstLineChunk(
  filePath: string,
): Promise<string | undefined> {
  const file = await Deno.open(filePath, { read: true });
  try {
    const buffer = new Uint8Array(32 * 1024);
    const read = await file.read(buffer);
    if (read === null || read === 0) {
      return undefined;
    }
    const chunk = new TextDecoder().decode(buffer.subarray(0, read));
    return chunk.split("\n").find((line) => line.trim().length > 0);
  } finally {
    file.close();
  }
}

export async function readCodexSessionMeta(
  filePath: string,
): Promise<CodexSessionMeta | undefined> {
  const firstLine = await readFirstLineChunk(filePath);
  return firstLine ? parseCodexSessionMetaLine(firstLine) : undefined;
}
