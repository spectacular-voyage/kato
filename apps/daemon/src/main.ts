import type { DaemonStatusSnapshot, RuntimeConfig } from "@kato/shared";
import { runDaemonCli } from "./cli/mod.ts";
import {
  resolveDefaultConfigPath,
  RuntimeConfigFileStore,
  type RuntimeConfigStoreLike,
} from "./config/mod.ts";
import {
  bootstrapOpenFeature,
  evaluateDaemonFeatureSettings,
} from "./feature_flags/mod.ts";
import {
  createDefaultStatusSnapshot,
  DaemonControlRequestFileStore,
  DaemonStatusSnapshotFileStore,
  resolveDefaultRuntimeDir,
  runDaemonRuntimeLoop,
} from "./orchestrator/mod.ts";
import { WritePathPolicyGate } from "./policy/mod.ts";
import { RecordingPipeline } from "./writer/mod.ts";

export interface RunDaemonSubprocessOptions {
  runtimeDir?: string;
  now?: () => Date;
  configStore?: RuntimeConfigStoreLike;
  runtimeLoop?: typeof runDaemonRuntimeLoop;
  writeStderr?: (text: string) => void;
}

function writeToStderr(text: string): void {
  const encoder = new TextEncoder();
  Deno.stderr.writeSync(encoder.encode(text));
}

export function createBootstrapStatusSnapshot(): DaemonStatusSnapshot {
  return createDefaultStatusSnapshot(new Date());
}

export function describeDaemonEntryPoint(): string {
  return "kato daemon entry point (launcher -> orchestrator)";
}

export async function runDaemonSubprocess(
  options: RunDaemonSubprocessOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const writeStderr = options.writeStderr ?? writeToStderr;
  const runtimeDir = options.runtimeDir ?? resolveDefaultRuntimeDir();
  const configPath = resolveDefaultConfigPath(runtimeDir);
  const configStore = options.configStore ?? new RuntimeConfigFileStore(
    configPath,
  );

  let runtimeConfig: RuntimeConfig;
  try {
    runtimeConfig = await configStore.load();
  } catch (error) {
    writeStderr(
      `Daemon startup failed: unable to load runtime config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }

  const featureClient = bootstrapOpenFeature(runtimeConfig.featureFlags);
  const featureSettings = evaluateDaemonFeatureSettings(featureClient);
  const recordingPipeline = new RecordingPipeline({
    pathPolicyGate: new WritePathPolicyGate({
      allowedRoots: runtimeConfig.allowedWriteRoots,
    }),
    now,
    defaultRenderOptions: featureSettings.writerRenderOptions,
  });
  const runtimeLoop = options.runtimeLoop ?? runDaemonRuntimeLoop;

  try {
    await runtimeLoop({
      statusStore: new DaemonStatusSnapshotFileStore(
        runtimeConfig.statusPath,
        now,
      ),
      controlStore: new DaemonControlRequestFileStore(
        runtimeConfig.controlPath,
        now,
      ),
      recordingPipeline,
      exportEnabled: featureSettings.exportEnabled,
      now,
    });
    return 0;
  } catch (error) {
    writeStderr(
      `Daemon runtime failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  if (Deno.args[0] === "__daemon-run") {
    const exitCode = await runDaemonSubprocess();
    Deno.exit(exitCode);
  }

  const exitCode = await runDaemonCli(Deno.args);
  Deno.exit(exitCode);
}
