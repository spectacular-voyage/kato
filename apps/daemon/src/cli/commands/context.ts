import type { DaemonCliRuntime } from "../types.ts";
import type { DaemonControlStateStoreLike } from "../state_store.ts";
import type { AuditLogger, StructuredLogger } from "../../observability/mod.ts";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  stateStore: DaemonControlStateStoreLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}
