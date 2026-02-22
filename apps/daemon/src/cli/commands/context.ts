import type { DaemonCliRuntime } from "../types.ts";
import type { AuditLogger, StructuredLogger } from "../../observability/mod.ts";
import type {
  DaemonControlRequestStoreLike,
  DaemonProcessLauncherLike,
  DaemonStatusSnapshotStoreLike,
} from "../../orchestrator/mod.ts";
import type { WritePathPolicyGateLike } from "../../policy/mod.ts";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  statusStore: DaemonStatusSnapshotStoreLike;
  controlStore: DaemonControlRequestStoreLike;
  daemonLauncher: DaemonProcessLauncherLike;
  pathPolicyGate: WritePathPolicyGateLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}
