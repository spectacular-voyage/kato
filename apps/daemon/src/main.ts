import type { DaemonStatusSnapshot, RuntimeConfig } from "@kato/shared";
import { dirname, join } from "@std/path";
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
  createDefaultProviderIngestionRunners,
  createDefaultStatusSnapshot,
  DaemonControlRequestFileStore,
  DaemonStatusSnapshotFileStore,
  InMemorySessionSnapshotStore,
  PersistentSessionStateStore,
  resolveDefaultDaemonControlIndexPath,
  resolveDefaultRuntimeDir,
  resolveDefaultSessionsDir,
  runDaemonRuntimeLoop,
} from "./orchestrator/mod.ts";
import {
  AuditLogger,
  JsonLineFileSink,
  type LogLevel,
  StructuredLogger,
} from "./observability/mod.ts";
import { WritePathPolicyGate } from "./policy/mod.ts";
import { readOptionalEnv } from "./utils/env.ts";
import { resolveExportsLogPath } from "./utils/exports_log.ts";
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

function parseLogLevelOverride(name: string): LogLevel | undefined {
  const raw = readOptionalEnv(name);
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (
    normalized !== "debug" &&
    normalized !== "info" &&
    normalized !== "warn" &&
    normalized !== "error"
  ) {
    throw new Error(`${name} must be one of: debug, info, warn, error`);
  }

  return normalized;
}

function resolveLogLevels(runtimeConfig: RuntimeConfig): {
  operationalLevel: LogLevel;
  auditLevel: LogLevel;
} {
  return {
    operationalLevel: parseLogLevelOverride("KATO_LOGGING_OPERATIONAL_LEVEL") ??
      runtimeConfig.logging.operationalLevel,
    auditLevel: parseLogLevelOverride("KATO_LOGGING_AUDIT_LEVEL") ??
      runtimeConfig.logging.auditLevel,
  };
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
  let logLevels: { operationalLevel: LogLevel; auditLevel: LogLevel };
  try {
    logLevels = resolveLogLevels(runtimeConfig);
  } catch (error) {
    writeStderr(
      `Daemon startup failed: invalid logging level override: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  const operationalLogPath = join(
    runtimeConfig.runtimeDir,
    "logs",
    "operational.jsonl",
  );
  const auditLogPath = join(
    runtimeConfig.runtimeDir,
    "logs",
    "security-audit.jsonl",
  );

  const operationalLogger = new StructuredLogger([
    new JsonLineFileSink(operationalLogPath),
  ], {
    channel: "operational",
    minLevel: logLevels.operationalLevel,
    now,
  });
  const auditLogger = new AuditLogger(
    new StructuredLogger([new JsonLineFileSink(auditLogPath)], {
      channel: "security-audit",
      minLevel: logLevels.auditLevel,
      now,
    }),
  );
  const sessionSnapshotStore = new InMemorySessionSnapshotStore({
    now,
    daemonMaxMemoryMb: runtimeConfig.daemonMaxMemoryMb,
  });
  const katoDir = dirname(runtimeConfig.runtimeDir);
  const sessionStateStore = new PersistentSessionStateStore({
    daemonControlIndexPath: resolveDefaultDaemonControlIndexPath(katoDir),
    sessionsDir: resolveDefaultSessionsDir(katoDir),
    now,
  });
  const ingestionRunners = createDefaultProviderIngestionRunners({
    sessionSnapshotStore,
    sessionStateStore,
    globalAutoGenerateSnapshots: runtimeConfig.globalAutoGenerateSnapshots,
    providerAutoGenerateSnapshots: runtimeConfig.providerAutoGenerateSnapshots,
    claudeSessionRoots: runtimeConfig.providerSessionRoots.claude,
    codexSessionRoots: runtimeConfig.providerSessionRoots.codex,
    geminiSessionRoots: runtimeConfig.providerSessionRoots.gemini,
    now,
    operationalLogger,
    auditLogger,
  });
  const recordingPipeline = new RecordingPipeline({
    pathPolicyGate: new WritePathPolicyGate({
      allowedRoots: runtimeConfig.allowedWriteRoots,
    }),
    now,
    defaultRenderOptions: featureSettings.writerRenderOptions,
    operationalLogger,
    auditLogger,
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
      ingestionRunners,
      sessionSnapshotStore,
      sessionStateStore,
      loadSessionSnapshot(sessionId: string) {
        const snapshot = sessionSnapshotStore.get(sessionId);
        if (!snapshot) {
          return Promise.resolve(undefined);
        }

        return Promise.resolve({
          provider: snapshot.provider,
          events: snapshot.events,
        });
      },
      exportEnabled: featureSettings.exportEnabled,
      exportsLogPath: resolveExportsLogPath(runtimeConfig.runtimeDir),
      cleanSessionStatesOnShutdown: runtimeConfig.cleanSessionStatesOnShutdown,
      operationalLogger,
      auditLogger,
      daemonMaxMemoryMb: runtimeConfig.daemonMaxMemoryMb,
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
