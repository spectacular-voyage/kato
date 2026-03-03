import { runDaemonCli } from "./mod.ts";

if (import.meta.main) {
  const exitCode = await runDaemonCli(Deno.args);
  Deno.exit(exitCode);
}
