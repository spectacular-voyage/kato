import type { DaemonCliCommandContext } from "./context.ts";
import { DEFAULT_KATO_WEB_HOSTNAME, DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import { createInitializedWebConfig, isProcessAlive } from "@kato/runtime";

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

  const pid = await ctx.webLauncher.launchDetached({
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
  });
  const startedAt = ctx.runtime.now().toISOString();
  const url = `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`;

  await ctx.webStatusStore.save({
    schemaVersion: 1,
    running: true,
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
    pid,
    startedAt,
    heartbeatAt: startedAt,
    url,
  });
  await ctx.operationalLogger.info(
    "web.start",
    "Web server started in background",
    { pid, hostname: ctx.webConfig.hostname, port: ctx.webConfig.port, url },
  );
  await ctx.auditLogger.command("web.start", {
    pid,
    hostname: ctx.webConfig.hostname,
    port: ctx.webConfig.port,
    url,
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
  const effective = {
    configured: ctx.webConfig !== undefined,
    running: status.running,
    hostname: ctx.webConfig?.hostname ?? status.hostname,
    port: ctx.webConfig?.port ?? status.port,
    pid: status.running ? status.pid : undefined,
    url: ctx.webConfig
      ? `http://${ctx.webConfig.hostname}:${ctx.webConfig.port}/`
      : status.url,
    startedAt: status.running ? status.startedAt : undefined,
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
