import type { DaemonStatusSnapshot } from "@kato/shared";
import { runDaemonCli } from "./cli/mod.ts";
import {
  createDefaultStatusSnapshot,
  runDaemonRuntimeLoop,
} from "./orchestrator/mod.ts";

export function createBootstrapStatusSnapshot(): DaemonStatusSnapshot {
  return createDefaultStatusSnapshot(new Date());
}

export function describeDaemonEntryPoint(): string {
  return "kato daemon entry point (launcher -> orchestrator)";
}

if (import.meta.main) {
  if (Deno.args[0] === "__daemon-run") {
    await runDaemonRuntimeLoop();
    Deno.exit(0);
  }

  const exitCode = await runDaemonCli(Deno.args);
  Deno.exit(exitCode);
}
