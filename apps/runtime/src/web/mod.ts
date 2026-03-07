import { dirname, fromFileUrl, join } from "@std/path";
import { writeTextAtomically } from "../config/file_store_utils.ts";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";

const WEB_STATUS_FILENAME = "kato-web-status.json";
const WEB_STATUS_SCHEMA_VERSION = 1;

export interface WebServerStatus {
  schemaVersion: 1;
  running: boolean;
  hostname?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
  heartbeatAt: string;
  url?: string;
}

export interface WebServerStatusStoreLike {
  load(): Promise<WebServerStatus>;
  save(status: WebServerStatus): Promise<void>;
}

export interface WebProcessLauncherLike {
  launchDetached(options: { hostname: string; port: number }): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebServerStatus(value: unknown): value is WebServerStatus {
  if (!isRecord(value)) {
    return false;
  }

  if (value["schemaVersion"] !== WEB_STATUS_SCHEMA_VERSION) {
    return false;
  }
  if (typeof value["running"] !== "boolean") {
    return false;
  }
  if (typeof value["heartbeatAt"] !== "string") {
    return false;
  }
  if (
    value["hostname"] !== undefined && typeof value["hostname"] !== "string"
  ) {
    return false;
  }
  if (value["port"] !== undefined && typeof value["port"] !== "number") {
    return false;
  }
  if (value["pid"] !== undefined && typeof value["pid"] !== "number") {
    return false;
  }
  if (
    value["startedAt"] !== undefined && typeof value["startedAt"] !== "string"
  ) {
    return false;
  }
  if (value["url"] !== undefined && typeof value["url"] !== "string") {
    return false;
  }
  return true;
}

export function createDefaultWebServerStatus(
  now: Date = new Date(),
): WebServerStatus {
  return {
    schemaVersion: WEB_STATUS_SCHEMA_VERSION,
    running: false,
    heartbeatAt: now.toISOString(),
  };
}

export function resolveDefaultWebStatusPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "web", WEB_STATUS_FILENAME);
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    Deno.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      return false;
    }
    return false;
  }
}

export class WebServerStatusFileStore implements WebServerStatusStoreLike {
  constructor(
    private readonly statusPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<WebServerStatus> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.statusPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return createDefaultWebServerStatus(this.now());
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isWebServerStatus(parsed)) {
        return parsed;
      }
    } catch {
      // invalid data falls back to default
    }

    return createDefaultWebServerStatus(this.now());
  }

  async save(status: WebServerStatus): Promise<void> {
    await writeTextAtomically(this.statusPath, JSON.stringify(status, null, 2));
  }
}

type DenoCommandOptions = ConstructorParameters<typeof Deno.Command>[1];
type CommandLike = { spawn(): { pid: number } };
type DenoCommandFactory = (
  command: string,
  options: DenoCommandOptions,
) => CommandLike;

function resolveWorkspaceRoot(): string {
  return dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url)))));
}

export class DenoDetachedWebLauncher implements WebProcessLauncherLike {
  constructor(
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly workspaceRoot: string = resolveWorkspaceRoot(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
  ) {}

  async launchDetached(
    options: { hostname: string; port: number },
  ): Promise<number> {
    const command = this.commandFactory(this.denoExecPath, {
      cwd: this.workspaceRoot,
      args: [
        "task",
        "--cwd",
        "apps/web",
        "dev",
        "--",
        "--host",
        options.hostname,
        "--port",
        String(options.port),
      ],
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
    });
    const child = command.spawn();
    return await Promise.resolve(child.pid);
  }
}
