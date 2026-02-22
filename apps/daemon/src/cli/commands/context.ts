import type { DaemonCliRuntime } from "../types.ts";
import type { AuditLogger, StructuredLogger } from "../../observability/mod.ts";
import type { RuntimeConfig } from "@kato/shared";
import type {
  DaemonControlRequestStoreLike,
  DaemonProcessLauncherLike,
  DaemonStatusSnapshotStoreLike,
} from "../../orchestrator/mod.ts";
import type { WritePathPolicyGateLike } from "../../policy/mod.ts";
import type { RuntimeConfigStoreLike } from "../../config/mod.ts";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  configStore: RuntimeConfigStoreLike;
  runtimeConfig: RuntimeConfig;
  defaultRuntimeConfig: RuntimeConfig;
  statusStore: DaemonStatusSnapshotStoreLike;
  controlStore: DaemonControlRequestStoreLike;
  daemonLauncher: DaemonProcessLauncherLike;
  pathPolicyGate: WritePathPolicyGateLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
}
