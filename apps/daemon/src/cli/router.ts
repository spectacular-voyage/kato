import { CliUsageError } from "./errors.ts";
import { parseDaemonCliArgs } from "./parser.ts";
import { getCommandUsage, getGlobalUsage } from "./usage.ts";
import type { DaemonCliRuntime } from "./types.ts";
import { DAEMON_APP_VERSION } from "../version.ts";
import type { RuntimeConfig } from "@kato/shared";
import {
  DaemonControlRequestFileStore,
  type DaemonControlRequestStoreLike,
  type DaemonProcessLauncherLike,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  DenoDetachedDaemonLauncher,
  resolveDefaultControlPath,
  resolveDefaultRuntimeDir,
  resolveDefaultStatusPath,
} from "../orchestrator/mod.ts";
import {
  createDefaultRuntimeConfig,
  resolveDefaultConfigPath,
  RuntimeConfigFileStore,
  type RuntimeConfigStoreLike,
} from "../config/mod.ts";
import {
  resolveDefaultAllowedWriteRoots,
  WritePathPolicyGate,
  type WritePathPolicyGateLike,
} from "../policy/mod.ts";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  runCleanCommand,
  runExportCommand,
  runInitCommand,
  runRestartCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
} from "./commands/mod.ts";

export interface RunDaemonCliOptions {
  runtime?: Partial<DaemonCliRuntime>;
  configStore?: RuntimeConfigStoreLike;
  defaultRuntimeConfig?: RuntimeConfig;
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  daemonLauncher?: DaemonProcessLauncherLike;
  pathPolicyGate?: WritePathPolicyGateLike;
  autoInitOnStart?: boolean;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

function writeToStream(
  stream: { writeSync(data: Uint8Array): number },
  text: string,
): void {
  const encoder = new TextEncoder();
  stream.writeSync(encoder.encode(text));
}

export function createDefaultCliRuntime(): DaemonCliRuntime {
  const runtimeDir = resolveDefaultRuntimeDir();
  return {
    runtimeDir,
    configPath: resolveDefaultConfigPath(runtimeDir),
    statusPath: resolveDefaultStatusPath(runtimeDir),
    controlPath: resolveDefaultControlPath(runtimeDir),
    now: () => new Date(),
    pid: Deno.pid,
    writeStdout: (text) => writeToStream(Deno.stdout, text),
    writeStderr: (text) => writeToStream(Deno.stderr, text),
  };
}

function buildRuntime(
  overrides: Partial<DaemonCliRuntime> | undefined,
): DaemonCliRuntime {
  const defaults = createDefaultCliRuntime();
  if (!overrides) {
    return defaults;
  }

  const runtimeDir = overrides.runtimeDir ?? defaults.runtimeDir;
  return {
    ...defaults,
    ...overrides,
    runtimeDir,
    configPath: overrides.configPath ?? resolveDefaultConfigPath(runtimeDir),
    statusPath: overrides.statusPath ?? resolveDefaultStatusPath(runtimeDir),
    controlPath: overrides.controlPath ?? resolveDefaultControlPath(runtimeDir),
  };
}

function renderUsage(topic?: Parameters<typeof getCommandUsage>[0]): string {
  if (topic) {
    return getCommandUsage(topic);
  }
  return getGlobalUsage();
}

function resolveAutoInitOnStartDefault(): boolean {
  try {
    const raw = Deno.env.get("KATO_AUTO_INIT_ON_START");
    if (raw === undefined) {
      return true;
    }

    const value = raw.trim().toLowerCase();
    if (value === "0" || value === "false" || value === "no") {
      return false;
    }
    if (value === "1" || value === "true" || value === "yes") {
      return true;
    }
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return true;
    }
    throw error;
  }
}

export async function runDaemonCli(
  args: string[],
  options: RunDaemonCliOptions = {},
): Promise<number> {
  const runtime = buildRuntime(options.runtime);
  const autoInitOnStart = options.autoInitOnStart ??
    resolveAutoInitOnStartDefault();

  const defaultRuntimeConfig = options.defaultRuntimeConfig ??
    createDefaultRuntimeConfig({
      runtimeDir: runtime.runtimeDir,
      statusPath: runtime.statusPath,
      controlPath: runtime.controlPath,
      allowedWriteRoots: resolveDefaultAllowedWriteRoots(),
      useHomeShorthand: true,
    });
  const configStore = options.configStore ??
    new RuntimeConfigFileStore(runtime.configPath);

  const operationalLogger = options.operationalLogger ??
    new StructuredLogger([new NoopSink()], {
      channel: "operational",
      minLevel: "info",
      now: runtime.now,
    });

  const auditLogger = options.auditLogger ??
    new AuditLogger(
      new StructuredLogger([new NoopSink()], {
        channel: "security-audit",
        minLevel: "info",
        now: runtime.now,
      }),
    );

  let intent;
  try {
    intent = parseDaemonCliArgs(args);
  } catch (error) {
    if (error instanceof CliUsageError) {
      runtime.writeStderr(`${error.message}\n\n`);
      runtime.writeStderr(`${getGlobalUsage()}\n`);
      return 2;
    }
    throw error;
  }

  if (intent.kind === "help") {
    runtime.writeStdout(`${renderUsage(intent.topic)}\n`);
    return 0;
  }

  if (intent.kind === "version") {
    runtime.writeStdout(`kato ${DAEMON_APP_VERSION}\n`);
    return 0;
  }

  let runtimeConfig = defaultRuntimeConfig;
  let autoInitializedConfigPath: string | undefined;
  if (intent.command.name !== "init") {
    try {
      runtimeConfig = await configStore.load();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (
          (intent.command.name === "start" ||
            intent.command.name === "restart") && autoInitOnStart
        ) {
          const initialized = await configStore.ensureInitialized(
            defaultRuntimeConfig,
          );
          runtimeConfig = initialized.config;
          if (initialized.created) {
            autoInitializedConfigPath = initialized.path;
            // Reload to resolve any persisted path shorthand (for example "~").
            runtimeConfig = await configStore.load();
          }
        } else {
          runtime.writeStderr(
            `Runtime config not found at ${runtime.configPath}. Run \`kato init\` first.\n`,
          );
          return 1;
        }
      } else {
        throw error;
      }
    }
  }

  const effectiveRuntime: DaemonCliRuntime = {
    ...runtime,
    runtimeDir: runtimeConfig.runtimeDir,
    statusPath: runtimeConfig.statusPath,
    controlPath: runtimeConfig.controlPath,
    allowedWriteRoots: [...runtimeConfig.allowedWriteRoots],
    providerSessionRoots: {
      claude: [...runtimeConfig.providerSessionRoots.claude],
      codex: [...runtimeConfig.providerSessionRoots.codex],
      gemini: [...runtimeConfig.providerSessionRoots.gemini],
    },
  };
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(effectiveRuntime.statusPath, runtime.now);
  const controlStore = options.controlStore ??
    new DaemonControlRequestFileStore(
      effectiveRuntime.controlPath,
      runtime.now,
    );
  const daemonLauncher = options.daemonLauncher ??
    new DenoDetachedDaemonLauncher(effectiveRuntime);
  const pathPolicyGate = options.pathPolicyGate ??
    new WritePathPolicyGate({
      allowedRoots: runtimeConfig.allowedWriteRoots,
    });

  const commandContext = {
    runtime: effectiveRuntime,
    configStore,
    runtimeConfig,
    defaultRuntimeConfig,
    statusStore,
    controlStore,
    daemonLauncher,
    pathPolicyGate,
    operationalLogger,
    auditLogger,
  };

  if (
    (intent.command.name === "start" || intent.command.name === "restart") &&
    autoInitializedConfigPath
  ) {
    runtime.writeStdout(
      `initialized runtime config at ${autoInitializedConfigPath}\n`,
    );
  }

  try {
    switch (intent.command.name) {
      case "init":
        await runInitCommand(commandContext);
        return 0;
      case "start":
        await runStartCommand(commandContext);
        return 0;
      case "restart":
        await runRestartCommand(commandContext);
        return 0;
      case "stop":
        await runStopCommand(commandContext);
        return 0;
      case "status":
        await runStatusCommand(commandContext, intent.command.asJson);
        return 0;
      case "export":
        await runExportCommand(
          commandContext,
          intent.command.sessionId,
          intent.command.outputPath,
          intent.command.format,
        );
        return 0;
      case "clean":
        await runCleanCommand(commandContext, {
          all: intent.command.all,
          dryRun: intent.command.dryRun,
          recordingsDays: intent.command.recordingsDays,
          sessionsDays: intent.command.sessionsDays,
        });
        return 0;
    }
  } catch (error) {
    runtime.writeStderr(
      `Command failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}
