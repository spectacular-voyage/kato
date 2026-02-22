import type { DaemonCliRuntime } from "../types.ts";
import type { AuditLogger, StructuredLogger } from "../../observability/mod.ts";
import type {
  DaemonControlRequestStoreLike,
  DaemonStatusSnapshotStoreLike,
} from "../../orchestrator/mod.ts";
import type { WritePathPolicyGateLike } from "../../policy/mod.ts";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  statusStore: DaemonStatusSnapshotStoreLike;
  controlStore: DaemonControlRequestStoreLike;
  pathPolicyGate: WritePathPolicyGateLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}
