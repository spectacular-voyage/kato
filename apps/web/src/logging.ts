import {
  AuditLogger,
  JsonLineFileSink,
  resolveDefaultKatoDir,
  StructuredLogger,
} from "@kato/runtime";
import { join } from "@std/path";

export interface CreateWebLoggersOptions {
  katoDir?: string;
}

export interface LogUnhandledWebRequestErrorOptions {
  katoDir?: string;
  operationalLogger?: StructuredLogger;
}

function resolveWebLogPath(katoDir: string, filename: string): string {
  return join(katoDir, "web", "logs", filename);
}

export function createWebOperationalLogger(
  options: CreateWebLoggersOptions = {},
): StructuredLogger {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  return new StructuredLogger([
    new JsonLineFileSink(resolveWebLogPath(katoDir, "operational.jsonl")),
  ], {
    channel: "operational",
  });
}

function createWebAuditLogger(
  options: CreateWebLoggersOptions = {},
): AuditLogger {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  return new AuditLogger(
    new StructuredLogger([
      new JsonLineFileSink(resolveWebLogPath(katoDir, "security-audit.jsonl")),
    ], {
      channel: "security-audit",
    }),
  );
}

export function createWebLoggers(
  options: CreateWebLoggersOptions = {},
): {
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
} {
  const operationalLogger = createWebOperationalLogger(options);
  const auditLogger = createWebAuditLogger(options);
  return { operationalLogger, auditLogger };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  return String(error);
}

function getErrorStack(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const stack = error.stack?.trim();
  return stack && stack.length > 0 ? stack : undefined;
}

export async function logUnhandledWebRequestError(
  request: Request,
  error: unknown,
  options: LogUnhandledWebRequestErrorOptions = {},
): Promise<void> {
  const operationalLogger = options.operationalLogger ??
    createWebOperationalLogger({ katoDir: options.katoDir });
  const url = new URL(request.url);
  await operationalLogger.error(
    "web.request.unhandled_error",
    "Unhandled web request error",
    {
      method: request.method,
      pathname: url.pathname,
      search: url.search || undefined,
      error: getErrorMessage(error),
      stack: getErrorStack(error),
    },
  );
}
