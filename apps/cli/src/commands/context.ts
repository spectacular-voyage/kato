import type { DaemonCliRuntime } from "../types.ts";
import type { AuditLogger, StructuredLogger } from "@kato/runtime";
import type {
  CliConfig,
  RuntimeConfig,
  SharedBehaviorConfig,
  WebConfig,
} from "@kato/shared";
import type {
  CliConfigStoreLike,
  DaemonControlRequestStoreLike,
  DaemonProcessLauncherLike,
  DaemonStatusSnapshotStoreLike,
  SharedBehaviorConfigStoreLike,
  WebConfigStoreLike,
  WebPortSelectorLike,
  WebProcessLauncherLike,
  WebServerStatusStoreLike,
} from "@kato/runtime";
import type { WritePathPolicyGateLike } from "@kato/runtime";
import type {
  RuntimeConfigStoreLike,
  UserConfigStoreLike,
} from "@kato/runtime";

export interface DaemonCliCommandContext {
  runtime: DaemonCliRuntime;
  configStore: RuntimeConfigStoreLike;
  sharedConfigStore: SharedBehaviorConfigStoreLike;
  cliConfigStore: CliConfigStoreLike;
  runtimeConfig: RuntimeConfig;
  sharedConfig: SharedBehaviorConfig;
  cliConfig: CliConfig;
  defaultRuntimeConfig: RuntimeConfig;
  defaultSharedConfig: SharedBehaviorConfig;
  defaultCliConfig: CliConfig;
  webConfigStore: WebConfigStoreLike;
  webConfig?: WebConfig;
  webStatusStore: WebServerStatusStoreLike;
  webLauncher: WebProcessLauncherLike;
  webPortSelector: WebPortSelectorLike;
  statusStore: DaemonStatusSnapshotStoreLike;
  controlStore: DaemonControlRequestStoreLike;
  daemonLauncher: DaemonProcessLauncherLike;
  pathPolicyGate: WritePathPolicyGateLike;
  operationalLogger: StructuredLogger;
  auditLogger: AuditLogger;
  resolveUserConfigStore: () => UserConfigStoreLike;
}
