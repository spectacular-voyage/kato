import type { ProviderSessionRoots } from "@kato/shared";

export type DaemonCliCommandName =
  | "init"
  | "start"
  | "restart"
  | "stop"
  | "status"
  | "workspace-init"
  | "workspace-register"
  | "workspace-list"
  | "workspace-unregister"
  | "export"
  | "clean";

export type DaemonCliCommand =
  | { name: "init" }
  | { name: "start" }
  | { name: "restart" }
  | { name: "stop" }
  | { name: "status"; asJson: boolean; all: boolean; live: boolean }
  | { name: "workspace-init"; dirPath?: string }
  | { name: "workspace-register"; alias?: string }
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
