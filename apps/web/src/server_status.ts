import { DEFAULT_KATO_WEB_HOSTNAME, DEFAULT_KATO_WEB_PORT } from "@kato/shared";
import {
  resolveDefaultWebStatusPath,
  WebServerStatusFileStore,
} from "@kato/runtime";
import { loadWebConfigState } from "./auth.ts";
import { WEB_APP_VERSION } from "./version.ts";

const HEARTBEAT_INTERVAL_MS = 5_000;
const WEB_STATUS_RUNTIME_KEY = "__katoWebStatusRuntime";

interface WebListenOptions {
  hostname: string;
  port: number;
}

export interface StartWebServerStatusHeartbeatOptions {
  args?: string[];
  katoDir?: string;
  statusPath?: string;
  now?: () => Date;
  heartbeatIntervalMs?: number;
}

interface WebStatusRuntimeState {
  active: boolean;
  startedAt: string;
  intervalId: ReturnType<typeof setInterval>;
  pendingWrite: Promise<void>;
}

function getGlobalRuntimeState(): WebStatusRuntimeState | undefined {
  return (globalThis as Record<string, unknown>)[WEB_STATUS_RUNTIME_KEY] as
    | WebStatusRuntimeState
    | undefined;
}

function setGlobalRuntimeState(state: WebStatusRuntimeState): void {
  (globalThis as Record<string, unknown>)[WEB_STATUS_RUNTIME_KEY] = state;
}

export function parseWebListenArgs(
  args: string[],
): Partial<WebListenOptions> {
  let hostname: string | undefined;
  let port: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--host") {
      hostname = args[index + 1] || hostname;
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      hostname = arg.slice("--host=".length) || hostname;
      continue;
    }
    if (arg === "--port") {
      const raw = args[index + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
      }
    }
  }

  return { hostname, port };
}

async function resolveWebListenOptions(
  options: StartWebServerStatusHeartbeatOptions = {},
): Promise<WebListenOptions> {
  const parsed = parseWebListenArgs(options.args ?? Deno.args);
  const { config } = await loadWebConfigState({ katoDir: options.katoDir });

  return {
    hostname: parsed.hostname ?? config?.hostname ?? DEFAULT_KATO_WEB_HOSTNAME,
    port: parsed.port ?? config?.port ?? DEFAULT_KATO_WEB_PORT,
  };
}

async function persistWebStatus(
  store: WebServerStatusFileStore,
  running: boolean,
  startedAt: string,
  listen: WebListenOptions,
  now: () => Date = () => new Date(),
): Promise<void> {
  await store.save({
    schemaVersion: 1,
    running,
    hostname: listen.hostname,
    port: listen.port,
    pid: running ? Deno.pid : undefined,
    startedAt: running ? startedAt : undefined,
    heartbeatAt: now().toISOString(),
    url: `http://${listen.hostname}:${listen.port}/`,
    version: WEB_APP_VERSION,
  });
}

export function startWebServerStatusHeartbeat(
  options: StartWebServerStatusHeartbeatOptions = {},
): void {
  if (getGlobalRuntimeState()) {
    return;
  }

  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const store = new WebServerStatusFileStore(
    options.statusPath ?? resolveDefaultWebStatusPath(options.katoDir),
  );
  const runtimeState: WebStatusRuntimeState = {
    active: true,
    startedAt,
    pendingWrite: Promise.resolve(),
    intervalId: setInterval(() => {
      void heartbeat(true);
    }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS),
  };
  setGlobalRuntimeState(runtimeState);

  const heartbeat = (running: boolean): Promise<void> => {
    runtimeState.pendingWrite = runtimeState.pendingWrite
      .catch(() => {})
      .then(async () => {
        if (!runtimeState.active && running) {
          return;
        }
        try {
          const listen = await resolveWebListenOptions(options);
          await persistWebStatus(store, running, startedAt, listen, now);
        } catch {
          // Status heartbeat is best-effort and must not break the web server.
        }
      });
    return runtimeState.pendingWrite;
  };

  const stop = () => {
    if (!runtimeState.active) {
      return;
    }
    runtimeState.active = false;
    clearInterval(runtimeState.intervalId);
    globalThis.removeEventListener("unload", stop);
    try {
      Deno.removeSignalListener("SIGINT", stop);
      Deno.removeSignalListener("SIGTERM", stop);
    } catch {
      // Some environments may not support signal listeners.
    }
    void heartbeat(false);
  };

  void heartbeat(true);
  globalThis.addEventListener("unload", stop);
  try {
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
  } catch {
    // Some environments may not support signal listeners.
  }
}
