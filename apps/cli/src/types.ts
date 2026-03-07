import type { ProviderSessionRoots } from "@kato/shared";

export type DaemonCliCommandName =
  | "init"
  | "start"
  | "restart"
  | "stop"
  | "status"
  | "web"
  | "workspace-init"
  | "workspace-register"
  | "workspace-list"
  | "workspace-unregister"
  | "export"
  | "clean"
  | "user";

export type DaemonCliCommand =
  | { name: "init" }
  | { name: "start" }
  | { name: "restart" }
  | { name: "stop" }
  | { name: "status"; asJson: boolean; all: boolean; live: boolean }
  | {
    name: "web-init";
    hostname?: string;
    port?: number;
    username: string;
    password: string;
  }
  | { name: "web-start" }
  | { name: "web-stop" }
  | { name: "web-status"; asJson: boolean }
  | { name: "workspace-init"; dirPath?: string }
  | { name: "workspace-register"; alias?: string; dirPath?: string }
  | { name: "workspace-list" }
  | { name: "workspace-unregister"; selector: string }
  | {
    name: "export";
    sessionId: string;
    outputPath?: string;
    format?: "markdown" | "jsonl";
  }
  | {
    name: "clean";
    all: boolean;
    dryRun: boolean;
    recordingsDays?: number;
    sessionsDays?: number;
  }
  | {
    name: "user-init";
  }
  | {
    name: "user-map-set";
    selector: string;
    username: string;
  }
  | {
    name: "user-map-list";
    asJson: boolean;
  }
  | {
    name: "user-map-delete";
    selector: string;
  }
  | {
    name: "user-default-set";
    username: string;
  }
  | {
    name: "user-default-clear";
  }
  | {
    name: "user-exclude-me";
    value: boolean;
  };

export type DaemonCliIntent =
  | { kind: "help"; topic?: DaemonCliCommandName }
  | { kind: "version" }
  | { kind: "command"; command: DaemonCliCommand };

export interface DaemonCliRuntime {
  runtimeDir: string;
  configPath: string;
  statusPath: string;
  controlPath: string;
  cwdPath?: string;
  allowedWriteRoots?: string[];
  providerSessionRoots?: ProviderSessionRoots;
  now: () => Date;
  pid: number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}
