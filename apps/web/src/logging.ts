import {
  AuditLogger,
  JsonLineFileSink,
  resolveDefaultKatoDir,
  StructuredLogger,
} from "@kato/runtime";
import { join } from "@std/path";

export function createWebLoggers(): {
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
} {
  const katoDir = resolveDefaultKatoDir();
  const operationalLogger = new StructuredLogger([
    new JsonLineFileSink(join(katoDir, "web", "logs", "operational.jsonl")),
  ], {
    channel: "operational",
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([
      new JsonLineFileSink(
        join(katoDir, "web", "logs", "security-audit.jsonl"),
      ),
    ], {
      channel: "security-audit",
    }),
  );
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
): Promise<void> {
  const { operationalLogger } = createWebLoggers();
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
