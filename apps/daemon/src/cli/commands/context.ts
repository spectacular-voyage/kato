import type { DaemonCliRuntime } from "../types.ts";
import type { AuditLogger, StructuredLogger } from "../../observability/mod.ts";
import type {
  DaemonControlRequestStoreLike,
  DaemonStatusSnapshotStoreLike,
} from "../../orchestrator/mod.ts";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  statusStore: DaemonStatusSnapshotStoreLike;
  controlStore: DaemonControlRequestStoreLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}
