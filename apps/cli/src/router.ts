import { CliUsageError } from "./errors.ts";
import { parseDaemonCliArgs } from "./parser.ts";
import { getCommandUsage, getGlobalUsage } from "./usage.ts";
import type { DaemonCliRuntime } from "./types.ts";
import { CLI_APP_VERSION } from "./version.ts";
import type {
  CliConfig,
  RuntimeConfig,
  SharedBehaviorConfig,
  WebConfig,
} from "@kato/shared";
import { dirname, join, resolve } from "@std/path";
import {
  CliConfigFileStore,
  type CliConfigStoreLike,
  createDefaultCliConfig,
  createDefaultRuntimeConfig,
  createDefaultSharedBehaviorConfig,
  DaemonControlRequestFileStore,
  type DaemonControlRequestStoreLike,
  type DaemonProcessLauncherLike,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  DenoDetachedDaemonLauncher,
  DenoDetachedWebLauncher,
  resolveDefaultCliConfigPath,
  resolveDefaultControlPath,
  resolveDefaultRuntimeDir,
  resolveDefaultSharedConfigPath,
  resolveDefaultStatusPath,
  resolveDefaultWebConfigPath,
  resolveDefaultWebStatusPath,
  resolveHomeDir,
  SharedBehaviorConfigFileStore,
  type SharedBehaviorConfigStoreLike,
  WebConfigFileStore,
  type WebConfigStoreLike,
  type WebProcessLauncherLike,
  WebServerStatusFileStore,
  type WebServerStatusStoreLike,
} from "@kato/runtime";
import {
  expandHomePath,
  resolveDefaultConfigPath,
  resolveDefaultUserConfigPath,
  RuntimeConfigFileStore,
  type RuntimeConfigStoreLike,
  UserConfigFileStore,
  type UserConfigStoreLike,
} from "@kato/runtime";
import {
  WritePathPolicyGate,
  type WritePathPolicyGateLike,
} from "@kato/runtime";
import {
  AuditLogger,
  JsonLineFileSink,
  NoopSink,
  StructuredLogger,
} from "@kato/runtime";
import {
  ensureGlobalConfigInitialized,
  runCleanCommand,
  runExportCommand,
  runInitCommand,
  runRestartCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
  runUserDefaultClearCommand,
  runUserDefaultSetCommand,
  runUserExcludeMeCommand,
  runUserInitCommand,
  runUserMapDeleteCommand,
  runUserMapListCommand,
  runUserMapSetCommand,
  runWebInitCommand,
  runWebStartCommand,
  runWebStatusCommand,
  runWebStopCommand,
  runWorkspaceInitCommand,
  runWorkspaceListCommand,
  runWorkspaceRegisterCommand,
  runWorkspaceUnregisterCommand,
} from "./commands/mod.ts";

export interface RunDaemonCliOptions {
  runtime?: Partial<DaemonCliRuntime>;
  configStore?: RuntimeConfigStoreLike;
  defaultRuntimeConfig?: RuntimeConfig;
  sharedConfigStore?: SharedBehaviorConfigStoreLike;
  defaultSharedConfig?: SharedBehaviorConfig;
  cliConfigStore?: CliConfigStoreLike;
  defaultCliConfig?: CliConfig;
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  daemonLauncher?: DaemonProcessLauncherLike;
  pathPolicyGate?: WritePathPolicyGateLike;
  userConfigStore?: UserConfigStoreLike;
  webConfigStore?: WebConfigStoreLike;
  webStatusStore?: WebServerStatusStoreLike;
  webLauncher?: WebProcessLauncherLike;
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
  const katoDir = dirname(runtimeDir);
  let cwdPath: string | undefined;
  try {
    cwdPath = Deno.cwd();
  } catch (error) {
    if (
      error instanceof Deno.errors.NotCapable ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      cwdPath = undefined;
    } else {
      throw error;
    }
  }
  return {
    runtimeDir,
    configPath: resolveDefaultConfigPath(runtimeDir),
    statusPath: resolveDefaultStatusPath(katoDir),
    controlPath: resolveDefaultControlPath(katoDir),
    cwdPath,
    now: () => new Date(),
    pid: Deno.pid,
    writeStdout: (text) => writeToStream(Deno.stdout, text),
    writeStderr: (text) => writeToStream(Deno.stderr, text),
  };
}

function hasCompleteRuntimeOverride(
  overrides: Partial<DaemonCliRuntime>,
): overrides is DaemonCliRuntime {
  return typeof overrides.runtimeDir === "string" &&
    typeof overrides.configPath === "string" &&
    typeof overrides.statusPath === "string" &&
    typeof overrides.controlPath === "string" &&
    typeof overrides.now === "function" &&
    typeof overrides.pid === "number" &&
    typeof overrides.writeStdout === "function" &&
    typeof overrides.writeStderr === "function";
}

function buildRuntime(
  overrides: Partial<DaemonCliRuntime> | undefined,
): DaemonCliRuntime {
  if (overrides && hasCompleteRuntimeOverride(overrides)) {
    return {
      ...overrides,
      ...(overrides.cwdPath !== undefined
        ? { cwdPath: overrides.cwdPath }
        : {}),
    };
  }

  const defaults = createDefaultCliRuntime();
  if (!overrides) {
    return defaults;
  }
  const runtimeDir = overrides.runtimeDir ?? defaults.runtimeDir;
  const katoDir = dirname(runtimeDir);
  return {
    ...defaults,
    ...overrides,
    runtimeDir,
    configPath: overrides.configPath ?? resolveDefaultConfigPath(runtimeDir),
    statusPath: overrides.statusPath ?? resolveDefaultStatusPath(katoDir),
    controlPath: overrides.controlPath ?? resolveDefaultControlPath(katoDir),
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

async function createCliLogSink(
  path: string,
): Promise<JsonLineFileSink | NoopSink> {
  try {
    await Deno.mkdir(dirname(path), { recursive: true });
  } catch (error) {
    if (
      error instanceof Deno.errors.NotCapable ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return new NoopSink();
    }
    throw error;
  }
  return new JsonLineFileSink(path);
}

function shouldWarnOnIgnoredLocalState(commandName: string): boolean {
  return commandName === "init" || commandName === "start" ||
    commandName === "restart";
}

function isUsingGlobalHomeKatoDir(effectiveKatoDir: string): boolean {
  const homeDir = resolveHomeDir();
  if (!homeDir) {
    return false;
  }
  return resolve(effectiveKatoDir) === resolve(join(homeDir, ".kato"));
}

async function resolveIgnoredLocalKatoDirWarning(
  commandName: string,
  cwdPath: string | undefined,
  effectiveKatoDir: string,
): Promise<string | undefined> {
  if (!shouldWarnOnIgnoredLocalState(commandName)) {
    return undefined;
  }
  if (!cwdPath || !isUsingGlobalHomeKatoDir(effectiveKatoDir)) {
    return undefined;
  }

  const localKatoDir = resolve(cwdPath, ".kato");
  if (localKatoDir === resolve(effectiveKatoDir)) {
    return undefined;
  }
  try {
    const stat = await Deno.stat(localKatoDir);
    if (!stat.isDirectory) {
      return undefined;
    }
    return `warning: detected local state at ${localKatoDir}; using global runtime root ${effectiveKatoDir}. Set KATO_RUNTIME_DIR to an absolute path if you intend to use local state.\n`;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotCapable ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function runDaemonCli(
  args: string[],
  options: RunDaemonCliOptions = {},
): Promise<number> {
  let runtime: DaemonCliRuntime;
  try {
    runtime = buildRuntime(options.runtime);
  } catch (error) {
    const writeStderr = options.runtime?.writeStderr ??
      ((text: string) => writeToStream(Deno.stderr, text));
    writeStderr(
      `Command failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
  const autoInitOnStart = options.autoInitOnStart ??
    resolveAutoInitOnStartDefault();
  let cachedUserConfigStore: UserConfigStoreLike | undefined;
  const resolveUserConfigStore = (): UserConfigStoreLike => {
    if (cachedUserConfigStore) {
      return cachedUserConfigStore;
    }
    cachedUserConfigStore = options.userConfigStore ??
      new UserConfigFileStore(resolveDefaultUserConfigPath());
    return cachedUserConfigStore;
  };

  const defaultRuntimeConfig = options.defaultRuntimeConfig ??
    createDefaultRuntimeConfig({
      runtimeDir: runtime.runtimeDir,
      useHomeShorthand: true,
    });
  const defaultSharedConfig = options.defaultSharedConfig ??
    createDefaultSharedBehaviorConfig({
      allowedWriteRoots: [],
      useHomeShorthand: true,
    });
  const defaultCliConfig = options.defaultCliConfig ??
    createDefaultCliConfig();
  const configStore = options.configStore ??
    new RuntimeConfigFileStore(runtime.configPath);
  let resolvedSharedConfigStore = options.sharedConfigStore;
  let resolvedCliConfigStore = options.cliConfigStore;
  let resolvedWebConfigStore = options.webConfigStore;
  const resolveRuntimeKatoDir = (config: RuntimeConfig): string =>
    expandHomePath(config.katoDir ?? dirname(config.runtimeDir));
  const resolveSharedConfigStore = (
    katoDir: string,
  ): SharedBehaviorConfigStoreLike => {
    if (resolvedSharedConfigStore) {
      return resolvedSharedConfigStore;
    }
    resolvedSharedConfigStore = new SharedBehaviorConfigFileStore(
      resolveDefaultSharedConfigPath(katoDir),
    );
    return resolvedSharedConfigStore;
  };
  const resolveCliConfigStore = (katoDir: string): CliConfigStoreLike => {
    if (resolvedCliConfigStore) {
      return resolvedCliConfigStore;
    }
    resolvedCliConfigStore = new CliConfigFileStore(
      resolveDefaultCliConfigPath(katoDir),
    );
    return resolvedCliConfigStore;
  };
  const resolveWebConfigStore = (katoDir: string): WebConfigStoreLike => {
    if (resolvedWebConfigStore) {
      return resolvedWebConfigStore;
    }
    resolvedWebConfigStore = new WebConfigFileStore(
      resolveDefaultWebConfigPath(katoDir),
    );
    return resolvedWebConfigStore;
  };

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
    runtime.writeStdout(`kato ${CLI_APP_VERSION}\n`);
    return 0;
  }

  let runtimeConfig = defaultRuntimeConfig;
  let sharedConfig = defaultSharedConfig;
  let cliConfig = defaultCliConfig;
  let webConfig: WebConfig | undefined;
  let autoInitializedRuntimeConfigPath: string | undefined;
  let autoInitializedSharedConfigPath: string | undefined;
  let autoInitializedCliConfigPath: string | undefined;
  let autoInitializedDefaultWorkspaceConfigPath: string | undefined;
  let autoInitializedUserConfigPath: string | undefined;
  const commandAllowsMissingRuntimeConfig = intent.command.name === "init" ||
    intent.command.name === "web-init" ||
    intent.command.name === "web-start" ||
    intent.command.name === "web-stop" ||
    intent.command.name === "web-status" ||
    intent.command.name === "workspace-init" ||
    intent.command.name === "workspace-register" ||
    intent.command.name === "workspace-list" ||
    intent.command.name === "workspace-unregister" ||
    intent.command.name === "user-init" ||
    intent.command.name === "user-map-set" ||
    intent.command.name === "user-map-list" ||
    intent.command.name === "user-map-delete" ||
    intent.command.name === "user-default-set" ||
    intent.command.name === "user-default-clear" ||
    intent.command.name === "user-exclude-me";
  const commandShouldTryLoadingRuntimeConfig = intent.command.name !== "init" &&
    intent.command.name !== "user-init";
  if (commandShouldTryLoadingRuntimeConfig) {
    try {
      runtimeConfig = await configStore.load();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (
          (intent.command.name === "start" ||
            intent.command.name === "restart") && autoInitOnStart
        ) {
          const initializationKatoDir = resolveRuntimeKatoDir(
            defaultRuntimeConfig,
          );
          const initialized = await ensureGlobalConfigInitialized({
            configStore,
            sharedConfigStore: resolveSharedConfigStore(
              initializationKatoDir,
            ),
            cliConfigStore: resolveCliConfigStore(initializationKatoDir),
            userConfigStore: resolveUserConfigStore(),
            defaultRuntimeConfig,
            defaultSharedConfig,
            defaultCliConfig,
            katoDir: initializationKatoDir,
          });
          if (initialized.runtimeConfigCreated) {
            autoInitializedRuntimeConfigPath = initialized.runtimeConfigPath;
          }
          if (initialized.sharedConfigCreated) {
            autoInitializedSharedConfigPath = initialized.sharedConfigPath;
          }
          if (initialized.cliConfigCreated) {
            autoInitializedCliConfigPath = initialized.cliConfigPath;
          }
          if (initialized.defaultWorkspaceConfigCreated) {
            autoInitializedDefaultWorkspaceConfigPath =
              initialized.defaultWorkspaceConfigPath;
          }
          if (initialized.userConfigCreated) {
            autoInitializedUserConfigPath = initialized.userConfigPath;
          }
          // Reload after init so persisted path shorthands (e.g. "~") are
          // expanded by the store's own load logic.
          runtimeConfig = await configStore.load();
        } else if (!commandAllowsMissingRuntimeConfig) {
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
  const runtimeKatoDir = resolveRuntimeKatoDir(runtimeConfig);
  const sharedConfigStore = resolveSharedConfigStore(runtimeKatoDir);
  const cliConfigStore = resolveCliConfigStore(runtimeKatoDir);
  const webConfigStore = resolveWebConfigStore(runtimeKatoDir);
  if (commandShouldTryLoadingRuntimeConfig) {
    try {
      sharedConfig = await sharedConfigStore.load();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        try {
          const sharedInitialized = await sharedConfigStore.ensureInitialized(
            defaultSharedConfig,
          );
          sharedConfig = sharedInitialized.config;
          if (sharedInitialized.created) {
            autoInitializedSharedConfigPath = sharedInitialized.path;
          }
        } catch (innerError) {
          if (
            innerError instanceof Deno.errors.NotCapable ||
            innerError instanceof Deno.errors.PermissionDenied
          ) {
            sharedConfig = defaultSharedConfig;
          } else {
            throw innerError;
          }
        }
      } else {
        throw error;
      }
    }

    try {
      cliConfig = await cliConfigStore.load();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        try {
          const cliInitialized = await cliConfigStore.ensureInitialized(
            defaultCliConfig,
          );
          cliConfig = cliInitialized.config;
          if (cliInitialized.created) {
            autoInitializedCliConfigPath = cliInitialized.path;
          }
        } catch (innerError) {
          if (
            innerError instanceof Deno.errors.NotCapable ||
            innerError instanceof Deno.errors.PermissionDenied
          ) {
            cliConfig = defaultCliConfig;
          } else {
            throw innerError;
          }
        }
      } else {
        throw error;
      }
    }
  }

  try {
    webConfig = await webConfigStore.load();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    webConfig = undefined;
  }

  const effectiveKatoDir = runtimeKatoDir;
  const effectiveRuntime: DaemonCliRuntime = {
    ...runtime,
    runtimeDir: runtimeConfig.runtimeDir,
    statusPath: resolveDefaultStatusPath(effectiveKatoDir),
    controlPath: resolveDefaultControlPath(effectiveKatoDir),
    allowedWriteRoots: [...sharedConfig.allowedWriteRoots],
    providerSessionRoots: {
      claude: [...runtimeConfig.providerSessionRoots.claude],
      codex: [...runtimeConfig.providerSessionRoots.codex],
      gemini: [...runtimeConfig.providerSessionRoots.gemini],
    },
  };
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(effectiveRuntime.statusPath, runtime.now);
  const webStatusStore = options.webStatusStore ??
    new WebServerStatusFileStore(
      resolveDefaultWebStatusPath(effectiveKatoDir),
      runtime.now,
    );
  const controlStore = options.controlStore ??
    new DaemonControlRequestFileStore(
      effectiveRuntime.controlPath,
      runtime.now,
    );
  const daemonLauncher = options.daemonLauncher ??
    new DenoDetachedDaemonLauncher(effectiveRuntime);
  const webLauncher = options.webLauncher ?? new DenoDetachedWebLauncher();
  const pathPolicyGate = options.pathPolicyGate ??
    new WritePathPolicyGate({
      allowedRoots: sharedConfig.allowedWriteRoots,
    });
  const cliOperationalLogPath = join(
    effectiveKatoDir,
    "cli",
    "logs",
    "operational.jsonl",
  );
  const cliAuditLogPath = join(
    effectiveKatoDir,
    "cli",
    "logs",
    "security-audit.jsonl",
  );
  const operationalLogger = options.operationalLogger ??
    new StructuredLogger([await createCliLogSink(cliOperationalLogPath)], {
      channel: "operational",
      minLevel: cliConfig.logging.operationalLevel,
      now: runtime.now,
    });
  const auditLogger = options.auditLogger ??
    new AuditLogger(
      new StructuredLogger([await createCliLogSink(cliAuditLogPath)], {
        channel: "security-audit",
        minLevel: cliConfig.logging.auditLevel,
        now: runtime.now,
      }),
    );

  const commandContext = {
    runtime: effectiveRuntime,
    configStore,
    sharedConfigStore,
    cliConfigStore,
    runtimeConfig,
    sharedConfig,
    cliConfig,
    defaultRuntimeConfig,
    defaultSharedConfig,
    defaultCliConfig,
    webConfigStore,
    webConfig,
    webStatusStore,
    webLauncher,
    statusStore,
    controlStore,
    daemonLauncher,
    pathPolicyGate,
    operationalLogger,
    auditLogger,
    resolveUserConfigStore,
  };

  if (
    (intent.command.name === "start" || intent.command.name === "restart") &&
    (autoInitializedRuntimeConfigPath ||
      autoInitializedSharedConfigPath ||
      autoInitializedCliConfigPath ||
      autoInitializedDefaultWorkspaceConfigPath ||
      autoInitializedUserConfigPath)
  ) {
    const lines: string[] = [];
    if (autoInitializedRuntimeConfigPath) {
      lines.push(
        `initialized runtime config at ${autoInitializedRuntimeConfigPath}`,
      );
    }
    if (autoInitializedSharedConfigPath) {
      lines.push(
        `initialized shared config at ${autoInitializedSharedConfigPath}`,
      );
    }
    if (autoInitializedCliConfigPath) {
      lines.push(`initialized CLI config at ${autoInitializedCliConfigPath}`);
    }
    if (autoInitializedDefaultWorkspaceConfigPath) {
      lines.push(
        `initialized default workspace config at ${autoInitializedDefaultWorkspaceConfigPath}`,
      );
    }
    if (autoInitializedUserConfigPath) {
      lines.push(
        `initialized user config at ${autoInitializedUserConfigPath}`,
      );
    }
    runtime.writeStdout(`${lines.join("\n")}\n`);
  }

  const ignoredLocalKatoWarning = await resolveIgnoredLocalKatoDirWarning(
    intent.command.name,
    runtime.cwdPath,
    effectiveKatoDir,
  );
  if (ignoredLocalKatoWarning) {
    runtime.writeStdout(ignoredLocalKatoWarning);
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
        await runStatusCommand(
          commandContext,
          intent.command.asJson,
          intent.command.all,
          intent.command.live,
        );
        return 0;
      case "web-init":
        await runWebInitCommand(commandContext, {
          hostname: intent.command.hostname,
          port: intent.command.port,
        });
        return 0;
      case "web-start":
        await runWebStartCommand(commandContext);
        return 0;
      case "web-stop":
        await runWebStopCommand(commandContext);
        return 0;
      case "web-status":
        await runWebStatusCommand(commandContext, intent.command.asJson);
        return 0;
      case "workspace-init":
        await runWorkspaceInitCommand(commandContext, intent.command.dirPath);
        return 0;
      case "workspace-register":
        await runWorkspaceRegisterCommand(
          commandContext,
          intent.command.alias,
          intent.command.dirPath,
        );
        return 0;
      case "workspace-list":
        await runWorkspaceListCommand(commandContext);
        return 0;
      case "workspace-unregister":
        await runWorkspaceUnregisterCommand(
          commandContext,
          intent.command.selector,
        );
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
      case "user-map-set":
        await runUserMapSetCommand(
          commandContext,
          intent.command.selector,
          intent.command.username,
        );
        return 0;
      case "user-init":
        await runUserInitCommand(commandContext);
        return 0;
      case "user-map-list":
        await runUserMapListCommand(commandContext, intent.command.asJson);
        return 0;
      case "user-map-delete":
        await runUserMapDeleteCommand(commandContext, intent.command.selector);
        return 0;
      case "user-default-set":
        await runUserDefaultSetCommand(commandContext, intent.command.username);
        return 0;
      case "user-default-clear":
        await runUserDefaultClearCommand(commandContext);
        return 0;
      case "user-exclude-me":
        await runUserExcludeMeCommand(commandContext, intent.command.value);
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
