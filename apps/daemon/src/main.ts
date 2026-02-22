import type { DaemonStatusSnapshot } from "@kato/shared";

export function createBootstrapStatusSnapshot(): DaemonStatusSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    daemonRunning: false,
    providers: [],
    recordings: {
      activeRecordings: 0,
      destinations: 0,
    },
  };
}

export function describeDaemonEntryPoint(): string {
  return "kato daemon entry point (launcher -> orchestrator)";
}

if (import.meta.main) {
  console.log(describeDaemonEntryPoint());
}
