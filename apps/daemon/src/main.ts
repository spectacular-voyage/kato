import type { DaemonStatusSnapshot } from "@kato/shared";
import { runDaemonCli } from "./cli/mod.ts";
import { createDefaultStatusSnapshot } from "./orchestrator/mod.ts";

export function createBootstrapStatusSnapshot(): DaemonStatusSnapshot {
  return createDefaultStatusSnapshot(new Date());
}

export function describeDaemonEntryPoint(): string {
  return "kato daemon entry point (launcher -> orchestrator)";
}

if (import.meta.main) {
  const exitCode = await runDaemonCli(Deno.args);
  Deno.exit(exitCode);
}
