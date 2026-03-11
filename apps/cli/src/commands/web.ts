import type { DaemonCliCommandContext } from "./context.ts";
import { DEFAULT_KATO_WEB_HOSTNAME, DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import { createInitializedWebConfig, isProcessAlive } from "@kato/runtime";

const STARTUP_ACK_TIMEOUT_MS = 10_000;
const STARTUP_ACK_POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForWebStartupAck(
  ctx: DaemonCliCommandContext,
  launchedPid: number,
  launchedAtMs: number,
  url: string,
): Promise<{
  heartbeatAt: string;
  ackLatencyMs: number;
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

    if (status.running && status.pid === launchedPid) {
      const heartbeatMs = Date.parse(status.heartbeatAt);
      if (Number.isFinite(heartbeatMs) && heartbeatMs >= launchedAtMs) {
        return {
          heartbeatAt: status.heartbeatAt,
          ackLatencyMs: Math.max(0, heartbeatMs - launchedAtMs),
          version: status.version,
        };
      }
    }

    if (!isProcessAlive(launchedPid)) {
      throw new Error(
        `Web server exited before startup acknowledgement (pid: ${launchedPid})`,
      );
    }

    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(STARTUP_ACK_POLL_INTERVAL_MS),
      });
      response.body?.cancel();
      return {
        heartbeatAt: new Date().toISOString(),
        ackLatencyMs: Math.max(0, Date.now() - launchedAtMs),
        version: status?.version,
      };
    } catch {
      // Keep polling until the process either responds or exits.
    }

    await sleep(STARTUP_ACK_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for web startup acknowledgement (pid: ${launchedPid})`,
  );
}

export async function runWebInitCommand(
  ctx: DaemonCliCommandContext,
  options: {
    hostname?: string;
    port?: number;
    username: string;
    password: string;
  },
): Promise<void> {
  const defaultConfig = await createInitializedWebConfig({
    hostname: options.hostname,
    port: options.port,
    username: options.username,
    password: options.password,
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
    `${
      result.created ? "created" : "web config already exists at"
    } web config at ${result.path}\n`,
  );
}

export async function runWebStartCommand(
  ctx: DaemonCliCommandContext,
): Promise<void> {
  if (!ctx.webConfig) {
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

  const launchedAtMs = ctx.runtime.now().getTime();
  const pid = await ctx.webLauncher.launchDetached({
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
  });
  const url = `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`;
  const startedAt = new Date(launchedAtMs).toISOString();
  const ack = await waitForWebStartupAck(ctx, pid, launchedAtMs, url).catch(
    async (error) => {
      await ctx.webStatusStore.save({
        schemaVersion: 1,
        running: false,
        hostname: ctx.webConfig?.hostname,
        port: ctx.webConfig?.port,
        heartbeatAt: ctx.runtime.now().toISOString(),
        url,
      });
      throw error;
    },
  );
  await ctx.webStatusStore.save({
    schemaVersion: 1,
    running: true,
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
    pid,
    startedAt,
    heartbeatAt: ack.heartbeatAt,
    url,
    version: ack.version,
  });

  await ctx.operationalLogger.info(
    "web.start",
    "Web server startup acknowledged by runtime heartbeat",
    {
      pid,
      hostname: ctx.webConfig.hostname,
      port: ctx.webConfig.port,
      url,
      startupAckHeartbeatAt: ack.heartbeatAt,
      startupAckLatencyMs: ack.ackLatencyMs,
      version: ack.version,
    },
  );
  await ctx.auditLogger.command("web.start", {
    pid,
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
    url,
    startupAckHeartbeatAt: ack.heartbeatAt,
    startupAckLatencyMs: ack.ackLatencyMs,
    version: ack.version,
  });
  ctx.runtime.writeStdout(
    `kato web started in background (pid: ${pid}) at ${url}\n`,
  );
}

export async function runWebStatusCommand(
  ctx: DaemonCliCommandContext,
  asJson: boolean,
): Promise<void> {
  const status = await ctx.webStatusStore.load();
  const alive = status.running && isProcessAlive(status.pid);
  const stale = status.running && !alive;
  const effective = {
    configured: ctx.webConfig !== undefined,
    running: alive,
    stale,
    state: alive ? "running" : stale ? "stale" : "stopped",
    hostname: ctx.webConfig?.hostname ?? status.hostname,
    port: ctx.webConfig?.port ?? status.port,
    pid: alive || stale ? status.pid : undefined,
    url: ctx.webConfig
      ? `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`
      : status.url,
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
      `kato web: ${
        effective.state === "stale"
          ? "stale status"
          : effective.running
          ? "running"
          : "stopped"
      }`,
      `version: ${effective.version ?? "unknown"}`,
      `host: ${effective.hostname ?? DEFAULT_KATO_WEB_HOSTNAME}`,
      `port: ${effective.port ?? DEFAULT_KATO_WEB_PORT}`,
      `url: ${effective.url ?? "n/a"}`,
      `pid: ${effective.pid ?? "n/a"}`,
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
    Deno.kill(status.pid, "SIGTERM");
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
