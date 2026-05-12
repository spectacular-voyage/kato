import type { DaemonCliCommandContext } from "./context.ts";
import {
  createDefaultWebPasswordPromptIO,
  promptForWebPassword,
} from "./web_password_prompt.ts";
import { DEFAULT_KATO_WEB_HOSTNAME, DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import {
  createInitializedWebConfig,
  isProcessAlive,
  terminateProcess,
} from "@kato/runtime";

const STARTUP_ACK_TIMEOUT_MS = 10_000;
const STARTUP_ACK_POLL_INTERVAL_MS = 100;
const STARTUP_LOG_TAIL_LINE_LIMIT = 20;
const STARTUP_LOG_TAIL_CHAR_LIMIT = 4_000;
const WEB_STOP_TIMEOUT_MS = 5_000;
const WEB_STOP_KILL_TIMEOUT_MS = 1_000;
const WEB_PASSWORD_ENV_VAR = "KATO_WEB_PASSWORD";

interface WebStartupLogPaths {
  startupStdoutLogPath?: string;
  startupStderrLogPath?: string;
}

interface AcknowledgedWebStatus {
  pid?: number;
  version?: string;
  heartbeatAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readStartupLogTail(
  path: string | undefined,
): Promise<string | undefined> {
  if (!path) {
    return undefined;
  }

  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return undefined;
  }

  const trimmed = raw.trimEnd();
  if (trimmed.length === 0) {
    return undefined;
  }

  const lineTail = trimmed.split(/\r?\n/).slice(-STARTUP_LOG_TAIL_LINE_LIMIT)
    .join("\n");
  if (lineTail.length <= STARTUP_LOG_TAIL_CHAR_LIMIT) {
    return lineTail;
  }
  return lineTail.slice(lineTail.length - STARTUP_LOG_TAIL_CHAR_LIMIT);
}

async function buildWebStartupAckFailureMessage(
  baseMessage: string,
  startupLogPaths: WebStartupLogPaths,
): Promise<string> {
  const lines = [baseMessage];
  if (startupLogPaths.startupStdoutLogPath) {
    lines.push(`Startup stdout log: ${startupLogPaths.startupStdoutLogPath}`);
  }
  if (startupLogPaths.startupStderrLogPath) {
    lines.push(`Startup stderr log: ${startupLogPaths.startupStderrLogPath}`);
  }

  const stderrTail = await readStartupLogTail(
    startupLogPaths.startupStderrLogPath,
  );
  if (stderrTail) {
    lines.push("Recent startup stderr output:", stderrTail);
  }
  const stdoutTail = await readStartupLogTail(
    startupLogPaths.startupStdoutLogPath,
  );
  if (stdoutTail) {
    lines.push("Recent startup stdout output:", stdoutTail);
  }

  return lines.join("\n");
}

function getAcknowledgedWebStatus(
  status:
    | Awaited<ReturnType<DaemonCliCommandContext["webStatusStore"]["load"]>>
    | undefined,
  launchedAtMs: number,
  url: string,
): AcknowledgedWebStatus | undefined {
  if (!status?.running) {
    return undefined;
  }
  const heartbeatMs = Date.parse(status.heartbeatAt);
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < launchedAtMs) {
    return undefined;
  }
  const expectedUrl = new URL(url);
  const expectedPort = Number.parseInt(expectedUrl.port, 10);
  if (
    status.hostname !== expectedUrl.hostname ||
    status.port !== expectedPort
  ) {
    return undefined;
  }
  return {
    pid: status.pid,
    version: status.version,
    heartbeatAt: status.heartbeatAt,
  };
}

async function waitForWebStartupAck(
  ctx: DaemonCliCommandContext,
  launchedPid: number,
  launchedAtMs: number,
  ackWaitStartedAtMs: number,
  url: string,
  startupLogPaths: WebStartupLogPaths = {},
): Promise<{
  heartbeatAt: string;
  totalLatencyMs: number;
  ackWaitMs: number;
  pid?: number;
  version?: string;
}> {
  const deadline = Date.now() + STARTUP_ACK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let status: Awaited<ReturnType<typeof ctx.webStatusStore.load>> | undefined;
    try {
      status = await ctx.webStatusStore.load();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        await ctx.operationalLogger.debug(
          "web.start.ack_poll_retry",
          "Transient web status read failure while waiting for startup acknowledgement",
          {
            launchedPid,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      await sleep(STARTUP_ACK_POLL_INTERVAL_MS);
      continue;
    }

    const acknowledged = getAcknowledgedWebStatus(status, launchedAtMs, url);
    if (acknowledged) {
      const heartbeatMs = Date.parse(acknowledged.heartbeatAt);
      return {
        heartbeatAt: acknowledged.heartbeatAt,
        totalLatencyMs: Math.max(0, heartbeatMs - launchedAtMs),
        ackWaitMs: Math.max(0, heartbeatMs - ackWaitStartedAtMs),
        pid: acknowledged.pid,
        version: acknowledged.version,
      };
    }

    if (!isProcessAlive(launchedPid)) {
      throw new Error(
        await buildWebStartupAckFailureMessage(
          `Web server exited before startup acknowledgement (pid: ${launchedPid})`,
          startupLogPaths,
        ),
      );
    }

    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(STARTUP_ACK_POLL_INTERVAL_MS),
      });
      response.body?.cancel();
      let refreshedStatus:
        | Awaited<ReturnType<typeof ctx.webStatusStore.load>>
        | undefined;
      try {
        refreshedStatus = await ctx.webStatusStore.load();
      } catch {
        refreshedStatus = undefined;
      }
      const acknowledgedAfterFetch = getAcknowledgedWebStatus(
        refreshedStatus ?? status,
        launchedAtMs,
        url,
      );
      return {
        heartbeatAt: acknowledgedAfterFetch?.heartbeatAt ??
          new Date().toISOString(),
        totalLatencyMs: Math.max(0, Date.now() - launchedAtMs),
        ackWaitMs: Math.max(0, Date.now() - ackWaitStartedAtMs),
        pid: acknowledgedAfterFetch?.pid,
        version: acknowledgedAfterFetch?.version ?? status?.version,
      };
    } catch {
      // Keep polling until the process either responds or exits.
    }

    await sleep(STARTUP_ACK_POLL_INTERVAL_MS);
  }

  throw new Error(
    await buildWebStartupAckFailureMessage(
      `Timed out waiting for web startup acknowledgement (pid: ${launchedPid})`,
      startupLogPaths,
    ),
  );
}

async function readPasswordFromStdin(): Promise<string> {
  if (Deno.stdin.isTerminal()) {
    throw new Error(
      "`kato web init --password-stdin` requires piped stdin input",
    );
  }

  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024);
  let text = "";
  while (true) {
    const read = await Deno.stdin.read(buffer);
    if (read === null) {
      break;
    }
    text += decoder.decode(buffer.subarray(0, read), { stream: true });
  }
  text += decoder.decode();

  const password = text.replace(/[\r\n]+$/, "");
  if (password.length === 0) {
    throw new Error("No password received on stdin");
  }
  return password;
}

function readPasswordFromEnv(): string | undefined {
  try {
    const value = Deno.env.get(WEB_PASSWORD_ENV_VAR);
    return value && value.length > 0 ? value : undefined;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotCapable ||
      error instanceof Deno.errors.PermissionDenied
    ) {
      return undefined;
    }
    throw error;
  }
}

export interface WebInitPasswordResolverDeps {
  readPasswordFromStdin?: () => Promise<string>;
  readPasswordFromEnv?: () => string | undefined;
  isInteractiveTerminal?: () => boolean;
  promptForPassword?: () => Promise<string>;
}

function writeToStderr(text: string): void {
  const encoder = new TextEncoder();
  Deno.stderr.writeSync(encoder.encode(text));
}

export async function resolveWebInitPassword(
  options: {
    passwordFromStdin?: boolean;
  },
  deps: WebInitPasswordResolverDeps = {},
): Promise<string> {
  const readFromStdin = deps.readPasswordFromStdin ?? readPasswordFromStdin;
  const readFromEnv = deps.readPasswordFromEnv ?? readPasswordFromEnv;
  const isInteractiveTerminal = deps.isInteractiveTerminal ??
    (() => Deno.stdin.isTerminal());
  const promptForPassword = deps.promptForPassword ??
    (() =>
      promptForWebPassword(createDefaultWebPasswordPromptIO(writeToStderr)));

  if (options.passwordFromStdin) {
    return await readFromStdin();
  }

  const password = readFromEnv();
  if (password) {
    return password;
  }

  if (isInteractiveTerminal()) {
    return await promptForPassword();
  }

  throw new Error(
    `Web init requires ${WEB_PASSWORD_ENV_VAR}, --password-stdin, or an interactive terminal prompt.`,
  );
}

function sendSignalIfRunning(
  pid: number,
  force: boolean,
): void {
  terminateProcess(pid, force);
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(STARTUP_ACK_POLL_INTERVAL_MS);
  }
  return !isProcessAlive(pid);
}

export async function runWebInitCommand(
  ctx: DaemonCliCommandContext,
  options: {
    hostname?: string;
    port?: number;
    username: string;
    passwordFromStdin?: boolean;
  },
): Promise<void> {
  const webConfigPath = ctx.webConfigStore.getPath();
  try {
    const existingConfig = await ctx.webConfigStore.load();

    await ctx.operationalLogger.info(
      "web.init",
      "Web config already present",
      {
        webConfigPath,
        webConfigCreated: false,
        hostname: existingConfig.hostname,
        port: existingConfig.port,
        username: existingConfig.auth.username,
      },
    );
    await ctx.auditLogger.command("web.init", {
      webConfigPath,
      webConfigCreated: false,
      hostname: existingConfig.hostname,
      port: existingConfig.port,
      username: existingConfig.auth.username,
    });

    ctx.runtime.writeStdout(`web config already exists at ${webConfigPath}\n`);
    return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const runtimeWebInitPassword = ctx.runtime.webInitPassword;
  const password = await resolveWebInitPassword(options, {
    readPasswordFromStdin: runtimeWebInitPassword?.readPasswordFromStdin,
    readPasswordFromEnv: runtimeWebInitPassword?.readPasswordFromEnv,
    isInteractiveTerminal: runtimeWebInitPassword?.isInteractiveTerminal ??
      ctx.runtime.isStdinTerminal ??
      (() => Deno.stdin.isTerminal()),
    promptForPassword: runtimeWebInitPassword?.promptForPassword ??
      (() =>
        promptForWebPassword(
          createDefaultWebPasswordPromptIO(ctx.runtime.writeStderr),
        )),
  });
  const defaultConfig = await createInitializedWebConfig({
    hostname: options.hostname,
    port: options.port,
    username: options.username,
    password,
  });
  const result = await ctx.webConfigStore.ensureInitialized(defaultConfig);

  await ctx.operationalLogger.info(
    "web.init",
    result.created ? "Web config initialized" : "Web config already present",
    {
      webConfigPath: result.path,
      webConfigCreated: result.created,
      hostname: result.config.hostname,
      port: result.config.port,
      username: result.config.auth.username,
    },
  );
  await ctx.auditLogger.command("web.init", {
    webConfigPath: result.path,
    webConfigCreated: result.created,
    hostname: result.config.hostname,
    port: result.config.port,
    username: result.config.auth.username,
  });

  ctx.runtime.writeStdout(
    result.created
      ? `created web config at ${result.path}\n`
      : `web config already exists at ${result.path}\n`,
  );
}

export async function runWebStartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const webConfig = ctx.webConfig;
  if (!webConfig) {
    throw new Error(
      "Web config not found. Run `kato web init` before `kato web start`.",
    );
  }

  const existingStatus = await ctx.webStatusStore.load();
  if (existingStatus.running && isProcessAlive(existingStatus.pid)) {
    ctx.runtime.writeStdout(
      `kato web already running at ${
        existingStatus.url ??
          `http://${existingStatus.hostname}:${existingStatus.port}/`
      } (pid: ${existingStatus.pid})\n`,
    );
    return;
  }

  const selectedPort = await ctx.webPortSelector.selectAvailablePort({
    hostname: webConfig.hostname,
    preferredPort: webConfig.port,
  });
  const portFallback = selectedPort !== webConfig.port;
  const launchStartedAtMs = ctx.runtime.now().getTime();
  const launchResult = ctx.webLauncher.launchDetachedDetailed
    ? await ctx.webLauncher.launchDetachedDetailed({
      hostname: webConfig.hostname,
      port: selectedPort,
    })
    : {
      pid: await ctx.webLauncher.launchDetached({
        hostname: webConfig.hostname,
        port: selectedPort,
      }),
    };
  const pid = launchResult.pid;
  const launchCompletedAtMs = ctx.runtime.now().getTime();
  const launchLatencyMs = Math.max(0, launchCompletedAtMs - launchStartedAtMs);
  const buildLatencyMs = launchResult.buildLatencyMs ?? 0;
  const detachLatencyMs = Math.max(0, launchLatencyMs - buildLatencyMs);
  const startupLogPaths = {
    startupStdoutLogPath: launchResult.startupStdoutLogPath,
    startupStderrLogPath: launchResult.startupStderrLogPath,
  };
  const url = `http://${webConfig.hostname}:${selectedPort}/`;
  const startedAt = new Date(launchStartedAtMs).toISOString();
  const ack = await waitForWebStartupAck(
    ctx,
    pid,
    launchStartedAtMs,
    launchCompletedAtMs,
    url,
    startupLogPaths,
  ).catch(
    async (error) => {
      await ctx.webStatusStore.save({
        schemaVersion: 1,
        running: false,
        hostname: webConfig.hostname,
        port: selectedPort,
        heartbeatAt: ctx.runtime.now().toISOString(),
        url,
      });
      throw error;
    },
  );
  const serverPid = ack.pid ?? pid;
  await ctx.webStatusStore.save({
    schemaVersion: 1,
    running: true,
    hostname: webConfig.hostname,
    port: selectedPort,
    pid: serverPid,
    startedAt,
    heartbeatAt: ack.heartbeatAt,
    url,
    version: ack.version,
  });

  await ctx.operationalLogger.info(
    "web.start",
    "Web server startup acknowledged by runtime heartbeat",
    {
      pid: serverPid,
      launcherPid: pid,
      hostname: webConfig.hostname,
      port: selectedPort,
      configuredPort: webConfig.port,
      portFallback,
      url,
      startupAckHeartbeatAt: ack.heartbeatAt,
      startupAckLatencyMs: ack.totalLatencyMs,
      startupLaunchLatencyMs: launchLatencyMs,
      startupBuildLatencyMs: buildLatencyMs,
      startupDetachLatencyMs: detachLatencyMs,
      startupAckWaitMs: ack.ackWaitMs,
      startupStdoutLogPath: launchResult.startupStdoutLogPath,
      startupStderrLogPath: launchResult.startupStderrLogPath,
      version: ack.version,
    },
  );
  await ctx.auditLogger.command("web.start", {
    pid: serverPid,
    launcherPid: pid,
    hostname: webConfig.hostname,
    port: selectedPort,
    configuredPort: webConfig.port,
    portFallback,
    url,
    startupAckHeartbeatAt: ack.heartbeatAt,
    startupAckLatencyMs: ack.totalLatencyMs,
    startupLaunchLatencyMs: launchLatencyMs,
    startupBuildLatencyMs: buildLatencyMs,
    startupDetachLatencyMs: detachLatencyMs,
    startupAckWaitMs: ack.ackWaitMs,
    version: ack.version,
  });
  ctx.runtime.writeStdout(
    `kato web started in background (pid: ${serverPid}) at ${url} in ${ack.totalLatencyMs}ms (build ${buildLatencyMs}ms, launch ${detachLatencyMs}ms, ack ${ack.ackWaitMs}ms)\n`,
  );
}

export async function runWebRestartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const status = await ctx.webStatusStore.load();
  const alive = status.running && isProcessAlive(status.pid);

  if (!alive) {
    await runWebStartCommand(ctx);

    await ctx.operationalLogger.info(
      "web.restart.start_only",
      "Web restart used start-only path because web status was stopped or stale",
      {
        running: status.running,
        previousPid: status.pid,
        url: status.url,
      },
    );
    await ctx.auditLogger.command("web.restart", {
      restartMode: "start-only",
      running: status.running,
      previousPid: status.pid,
      url: status.url,
    });
    return;
  }

  await runWebStopCommand(ctx);
  await runWebStartCommand(ctx);

  await ctx.operationalLogger.info(
    "web.restart",
    "Web server restart completed (stop then start)",
    {
      previousPid: status.pid,
      url: status.url,
    },
  );
  await ctx.auditLogger.command("web.restart", {
    restartMode: "stop-then-start",
    previousPid: status.pid,
    url: status.url,
  });
}

export async function runWebStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const status = await ctx.webStatusStore.load();
  const alive = status.running && isProcessAlive(status.pid);
  const stale = status.running && !alive;
  const useStoredEndpoint = alive || stale;
  const hostname = useStoredEndpoint
    ? status.hostname ?? ctx.webConfig?.hostname
    : ctx.webConfig?.hostname ?? status.hostname;
  const port = useStoredEndpoint
    ? status.port ?? ctx.webConfig?.port
    : ctx.webConfig?.port ?? status.port;
  const url = useStoredEndpoint
    ? status.url ??
      (hostname && port ? `http://${hostname}:${port}/` : undefined)
    : ctx.webConfig
    ? `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`
    : status.url;
  const effective = {
    configured: ctx.webConfig !== undefined,
    running: alive,
    stale,
    state: alive ? "running" : "stopped",
    hostname,
    port,
    pid: alive || stale ? status.pid : undefined,
    heartbeatAt: status.heartbeatAt,
    url,
    startedAt: alive || stale ? status.startedAt : undefined,
    version: status.version,
  };

  if (asJson) {
    ctx.runtime.writeStdout(`${JSON.stringify(effective, null, 2)}\n`);
    return;
  }

  if (!effective.configured) {
    ctx.runtime.writeStdout(
      "kato web: unconfigured\nRun `kato web init` first.\n",
    );
    return;
  }

  ctx.runtime.writeStdout(
    [
      `kato web: ${effective.running ? "running" : "stopped"}`,
      `version: ${effective.version ?? "unknown"}`,
      `host: ${effective.hostname ?? DEFAULT_KATO_WEB_HOSTNAME}`,
      `port: ${effective.port ?? DEFAULT_KATO_WEB_PORT}`,
      `url: ${effective.url ?? "n/a"}`,
      `pid: ${effective.pid ?? "n/a"}`,
      ...(effective.stale
        ? [`last heartbeat: ${effective.heartbeatAt ?? "unknown"}`]
        : []),
    ].join("\n") + "\n",
  );
}

export async function runWebStopCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  const status = await ctx.webStatusStore.load();
  const alive = status.running && isProcessAlive(status.pid);

  if (!alive) {
    await ctx.webStatusStore.save({
      schemaVersion: 1,
      running: false,
      hostname: status.hostname,
      port: status.port,
      heartbeatAt: ctx.runtime.now().toISOString(),
      url: status.url,
    });
    ctx.runtime.writeStdout("kato web already stopped.\n");
    return;
  }

  if (status.pid !== undefined) {
    sendSignalIfRunning(status.pid, false);
    if (!(await waitForProcessExit(status.pid, WEB_STOP_TIMEOUT_MS))) {
      sendSignalIfRunning(status.pid, true);
      if (!(await waitForProcessExit(status.pid, WEB_STOP_KILL_TIMEOUT_MS))) {
        throw new Error(
          `Timed out waiting for web server to stop (pid: ${status.pid})`,
        );
      }
    }
  }
  await ctx.webStatusStore.save({
    schemaVersion: 1,
    running: false,
    hostname: status.hostname,
    port: status.port,
    heartbeatAt: ctx.runtime.now().toISOString(),
    url: status.url,
  });
  await ctx.operationalLogger.info(
    "web.stop",
    "Web server stopped",
    { pid: status.pid, hostname: status.hostname, port: status.port },
  );
  await ctx.auditLogger.command("web.stop", {
    pid: status.pid,
    hostname: status.hostname,
    port: status.port,
  });
  ctx.runtime.writeStdout(`kato web stopped (pid: ${status.pid})\n`);
}
