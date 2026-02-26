import { dirname, join } from "@std/path";

const EXPORTS_LOG_SCHEMA_VERSION = 1;
const EXPORTS_LOG_FILENAME = "exports.jsonl";

export type ExportLogStatus = "queued" | "succeeded" | "failed";

export interface ExportLogEntry {
  schemaVersion: number;
  recordedAt: string;
  requestId: string;
  requestedAt?: string;
  status: ExportLogStatus;
  sessionId?: string;
  outputPath?: string;
  format?: "markdown" | "jsonl";
  provider?: string;
  reason?: string;
  error?: string;
  matchedBy?: string;
}

export function resolveExportsLogPath(runtimeDir: string): string {
  return join(dirname(runtimeDir), EXPORTS_LOG_FILENAME);
}

export async function appendExportsLogEntry(
  path: string,
  entry: Omit<ExportLogEntry, "schemaVersion">,
): Promise<void> {
  const line = JSON.stringify({
    schemaVersion: EXPORTS_LOG_SCHEMA_VERSION,
    ...entry,
  });
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${line}\n`, { append: true, create: true });
}
