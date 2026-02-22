import type { StructuredLogger } from "./logger.ts";

export class AuditLogger {
  constructor(private readonly logger: StructuredLogger) {}

  record(
    event: string,
    message: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.logger.info(event, message, attributes);
  }

  command(
    commandName: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.record("cli.command", "CLI command invoked", {
      commandName,
      ...attributes,
    });
  }

  policyDecision(
    decision: "allow" | "deny",
    targetPath: string,
    reason: string,
    attributes?: Record<string, unknown>,
  ): Promise<void> {
    return this.record("policy.decision", "Policy decision recorded", {
      decision,
      targetPath,
      reason,
      ...attributes,
    });
  }
}
