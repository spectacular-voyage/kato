export type DaemonCliCommandName =
  | "init"
  | "start"
  | "stop"
  | "status"
  | "export"
  | "clean";

export type DaemonCliCommand =
  | { name: "init" }
  | { name: "start" }
  | { name: "stop" }
  | { name: "status"; asJson: boolean }
  | { name: "export"; sessionId: string; outputPath?: string }
  | {
    name: "clean";
    all: boolean;
    dryRun: boolean;
    recordingsDays?: number;
    sessionsDays?: number;
  };

export type DaemonCliIntent =
  | { kind: "help"; topic?: DaemonCliCommandName }
  | { kind: "command"; command: DaemonCliCommand };

export interface DaemonCliRuntime {
  runtimeDir: string;
  configPath: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots?: string[];
  now: () => Date;
  pid: number;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
}
