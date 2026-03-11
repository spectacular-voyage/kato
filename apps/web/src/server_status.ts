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
  args: string[] = Deno.args,
): Promise<WebListenOptions> {
  const parsed = parseWebListenArgs(args);
  const { config } = await loadWebConfigState();

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
): Promise<void> {
  await store.save({
    schemaVersion: 1,
    running,
    hostname: listen.hostname,
    port: listen.port,
    pid: running ? Deno.pid : undefined,
    startedAt: running ? startedAt : undefined,
    heartbeatAt: new Date().toISOString(),
    url: `http://${listen.hostname}:${listen.port}/`,
    version: WEB_APP_VERSION,
  });
}

export function startWebServerStatusHeartbeat(): void {
  if (getGlobalRuntimeState()) {
    return;
  }

  const startedAt = new Date().toISOString();
  const store = new WebServerStatusFileStore(resolveDefaultWebStatusPath());
  const runtimeState: WebStatusRuntimeState = {
    active: true,
    startedAt,
    pendingWrite: Promise.resolve(),
    intervalId: setInterval(() => {
      void heartbeat(true);
    }, HEARTBEAT_INTERVAL_MS),
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
          const listen = await resolveWebListenOptions();
          await persistWebStatus(store, running, startedAt, listen);
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
