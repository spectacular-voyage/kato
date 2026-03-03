import type {
  DaemonStatusSnapshot,
  ExportFeatureFlags,
  MarkdownFrontmatterConfig,
  RuntimeConfig,
  SharedBehaviorConfig,
  UserConfig,
} from "@kato/shared";
import { dirname, join } from "@std/path";
import {
  createDefaultSharedBehaviorConfig,
  createDefaultUserConfig,
  resolveDefaultConfigPath,
  resolveDefaultSharedConfigPath,
  resolveDefaultUserConfigPath,
  resolveFrontmatterParticipantUsername,
  RuntimeConfigFileStore,
  type RuntimeConfigStoreLike,
  SharedBehaviorConfigFileStore,
  type SharedBehaviorConfigStoreLike,
  UserConfigFileStore,
  type UserConfigStoreLike,
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
  resolveDefaultControlPath,
  resolveDefaultDaemonControlIndexPath,
  resolveDefaultRuntimeDir,
  resolveDefaultSessionsDir,
  resolveDefaultStatusPath,
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
import {
  createDefaultWorkspaceMarkdownFrontmatterConfig,
  createDefaultWorkspaceWriterFeatureFlags,
  resolveDefaultWorkspaceRegistryPath,
  WorkspaceRegistryFileStore,
} from "./workspace/mod.ts";
import {
  type RecordingOutputOverrides,
  RecordingPipeline,
} from "./writer/mod.ts";

export interface RunDaemonSubprocessOptions {
  runtimeDir?: string;
  now?: () => Date;
  configStore?: RuntimeConfigStoreLike;
  sharedConfigStore?: SharedBehaviorConfigStoreLike;
  userConfigStore?: UserConfigStoreLike;
  runtimeLoop?: typeof runDaemonRuntimeLoop;
  writeStderr?: (text: string) => void;
}

function writeToStderr(text: string): void {
  const encoder = new TextEncoder();
  Deno.stderr.writeSync(encoder.encode(text));
}

async function logBestEffortStartupError(
  runtimeDir: string,
  timestamp: Date,
  event: string,
  message: string,
  attributes?: Record<string, unknown>,
): Promise<void> {
  const logPath = join(runtimeDir, "logs", "operational.jsonl");
  const record = {
    timestamp: timestamp.toISOString(),
    level: "error" as const,
    channel: "operational" as const,
    event,
    message,
    ...(attributes ? { attributes } : {}),
  };
  try {
    await Deno.mkdir(dirname(logPath), { recursive: true });
    await Deno.writeTextFile(
      logPath,
      `${JSON.stringify(record)}\n`,
      { append: true, create: true },
    );
  } catch {
    // Startup logging is best-effort; stderr remains the authoritative signal.
  }
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

async function loadUserConfigForRuntime(
  explicitStore?: UserConfigStoreLike,
): Promise<UserConfig> {
  const store = explicitStore ??
    (() => {
      try {
        return new UserConfigFileStore(resolveDefaultUserConfigPath());
      } catch {
        return undefined;
      }
    })();

  if (!store) {
    return createDefaultUserConfig();
  }

  try {
    return await store.load();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return createDefaultUserConfig();
    }
    throw error;
  }
}

function buildOutputOverrides(options: {
  markdownFrontmatter: MarkdownFrontmatterConfig;
  featureFlags: ExportFeatureFlags;
  includeSystemEvents: boolean;
  userConfig: UserConfig;
  workspaceId?: string;
  exportTimezone?: string;
}): RecordingOutputOverrides {
  return {
    includeFrontmatter:
      options.markdownFrontmatter.includeFrontmatterInMarkdownRecordings,
    includeUpdatedInFrontmatter:
      options.markdownFrontmatter.includeUpdatedInFrontmatter,
    includeSessionIds: options.markdownFrontmatter.includeSessionIds,
    includeWorkspaceIds: options.markdownFrontmatter.includeWorkspaceIds,
    includeRecordingIds: options.markdownFrontmatter.includeRecordingIds,
    includeConversationEventKinds:
      options.markdownFrontmatter.includeConversationEventKinds,
    participantUsername: resolveFrontmatterParticipantUsername(
      {
        markdownFrontmatter: options.markdownFrontmatter,
        userConfig: options.userConfig,
        workspaceId: options.workspaceId,
      },
    ),
    renderOptions: {
      includeCommentary: options.featureFlags.writerIncludeCommentary,
      includeThinking: options.featureFlags.writerIncludeThinking,
      includeToolCalls: options.featureFlags.writerIncludeToolCalls,
      includeToolResults: options.featureFlags.writerIncludeToolResults,
      includeDecisionPrompt: options.featureFlags.writerIncludeDecisionPrompt,
      includeDecisionOptions: options.featureFlags.writerIncludeDecisionOptions,
      includeDecisionSelection:
        options.featureFlags.writerIncludeDecisionSelection,
      italicizeUserMessages: options.featureFlags.writerItalicizeUserMessages,
      includeSystemEvents: options.includeSystemEvents,
      headingTimestampTimezone: options.exportTimezone ?? "local",
    },
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logBestEffortStartupError(
      runtimeDir,
      now(),
      "daemon.startup.config_load_failed",
      "Daemon startup failed while loading runtime config",
      {
        configPath,
        error: errorMessage,
        severity: "critical",
      },
    );
    writeStderr(
      `Daemon startup failed: unable to load runtime config at ${configPath}: ${errorMessage}\n`,
    );
    return 1;
  }
  const katoDir = typeof runtimeConfig.katoDir === "string" &&
      runtimeConfig.katoDir.trim().length > 0
    ? runtimeConfig.katoDir
    : dirname(runtimeConfig.runtimeDir);
  if (katoDir.trim().length === 0) {
    throw new Error(
      "Runtime config must provide a valid katoDir or runtimeDir",
    );
  }

  const sharedConfigPath = resolveDefaultSharedConfigPath(katoDir);
  const sharedConfigStore = options.sharedConfigStore ??
    new SharedBehaviorConfigFileStore(sharedConfigPath);
  let sharedConfig: SharedBehaviorConfig;
  try {
    const initialized = await sharedConfigStore.ensureInitialized(
      createDefaultSharedBehaviorConfig({
        allowedWriteRoots: [],
        useHomeShorthand: true,
      }),
    );
    sharedConfig = initialized.config;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logBestEffortStartupError(
      runtimeConfig.runtimeDir,
      now(),
      "daemon.startup.shared_config_load_failed",
      "Daemon startup failed while loading shared config",
      {
        sharedConfigPath,
        error: errorMessage,
        severity: "critical",
      },
    );
    writeStderr(
      `Daemon startup failed: unable to load shared config at ${sharedConfigPath}: ${errorMessage}\n`,
    );
    return 1;
  }

  let userConfig: UserConfig;
  try {
    userConfig = await loadUserConfigForRuntime(options.userConfigStore);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logBestEffortStartupError(
      runtimeConfig.runtimeDir,
      now(),
      "daemon.startup.user_config_load_failed",
      "Daemon startup failed while loading user config",
      {
        error: errorMessage,
        severity: "critical",
      },
    );
    writeStderr(
      `Daemon startup failed: unable to load user config: ${errorMessage}\n`,
    );
    return 1;
  }

  const featureClient = bootstrapOpenFeature(runtimeConfig.daemonFeatureFlags);
  const featureSettings = evaluateDaemonFeatureSettings(featureClient);
  let logLevels: { operationalLevel: LogLevel; auditLevel: LogLevel };
  try {
    logLevels = resolveLogLevels(runtimeConfig);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logBestEffortStartupError(
      runtimeConfig.runtimeDir,
      now(),
      "daemon.startup.logging_level_invalid",
      "Daemon startup failed due to invalid logging level override",
      {
        error: errorMessage,
        severity: "critical",
      },
    );
    writeStderr(
      `Daemon startup failed: invalid logging level override: ${errorMessage}\n`,
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
  const workspaceFrontmatterDefaults =
    createDefaultWorkspaceMarkdownFrontmatterConfig();
  const workspaceWriterDefaults = createDefaultWorkspaceWriterFeatureFlags();
  const recordingPipeline = new RecordingPipeline({
    pathPolicyGate: new WritePathPolicyGate({
      allowedRoots: sharedConfig.allowedWriteRoots,
    }),
    now,
    includeFrontmatterInMarkdownRecordings:
      workspaceFrontmatterDefaults.includeFrontmatterInMarkdownRecordings,
    includeUpdatedInFrontmatter:
      workspaceFrontmatterDefaults.includeUpdatedInFrontmatter,
    includeSessionIdsInFrontmatter:
      workspaceFrontmatterDefaults.includeSessionIds,
    includeWorkspaceIdsInFrontmatter:
      workspaceFrontmatterDefaults.includeWorkspaceIds,
    includeRecordingIdsInFrontmatter:
      workspaceFrontmatterDefaults.includeRecordingIds,
    includeConversationEventKindsInFrontmatter:
      workspaceFrontmatterDefaults.includeConversationEventKinds,
    frontmatterParticipantUsername: resolveFrontmatterParticipantUsername(
      {
        markdownFrontmatter: workspaceFrontmatterDefaults,
        userConfig,
      },
    ),
    defaultRenderOptions: {
      includeCommentary: workspaceWriterDefaults.writerIncludeCommentary,
      includeThinking: workspaceWriterDefaults.writerIncludeThinking,
      includeToolCalls: workspaceWriterDefaults.writerIncludeToolCalls,
      includeToolResults: workspaceWriterDefaults.writerIncludeToolResults,
      includeDecisionPrompt:
        workspaceWriterDefaults.writerIncludeDecisionPrompt,
      includeDecisionOptions:
        workspaceWriterDefaults.writerIncludeDecisionOptions,
      includeDecisionSelection:
        workspaceWriterDefaults.writerIncludeDecisionSelection,
      italicizeUserMessages:
        workspaceWriterDefaults.writerItalicizeUserMessages,
      includeSystemEvents: featureSettings.captureIncludeSystemEvents,
    },
    operationalLogger,
    auditLogger,
  });
  const runtimeLoop = options.runtimeLoop ?? runDaemonRuntimeLoop;

  try {
    await runtimeLoop({
      statusStore: new DaemonStatusSnapshotFileStore(
        resolveDefaultStatusPath(runtimeConfig.runtimeDir),
        now,
      ),
      controlStore: new DaemonControlRequestFileStore(
        resolveDefaultControlPath(runtimeConfig.runtimeDir),
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
      daemonFeatureFlags: runtimeConfig.daemonFeatureFlags,
      defaultCliExportOutputOverrides: buildOutputOverrides({
        markdownFrontmatter: sharedConfig.exportMarkdownFrontmatter,
        featureFlags: sharedConfig.exportFeatureFlags,
        includeSystemEvents: featureSettings.captureIncludeSystemEvents,
        userConfig,
        exportTimezone: sharedConfig.exportTimezone,
      }),
      userConfig,
      workspaceRegistryStore: new WorkspaceRegistryFileStore(
        resolveDefaultWorkspaceRegistryPath(
          katoDir,
        ),
      ),
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
  const mode = Deno.args[0];
  if (mode === undefined || mode === "run" || mode === "__daemon-run") {
    const exitCode = await runDaemonSubprocess();
    Deno.exit(exitCode);
  }
  writeToStderr(
    `Unsupported daemon command: ${mode}. Use \`deno run -A apps/daemon/src/main.ts run\`.\n`,
  );
  Deno.exit(2);
}
