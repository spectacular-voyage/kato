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
