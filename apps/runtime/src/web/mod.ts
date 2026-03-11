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
  version?: string;
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
  if (
    value["version"] !== undefined && typeof value["version"] !== "string"
  ) {
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
type CommandOutputLike = {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};
type CommandLike = {
  spawn(): { pid: number };
  output?(): Promise<CommandOutputLike>;
};
type DenoCommandFactory = (
  command: string,
  options: DenoCommandOptions,
) => CommandLike;

function resolveWorkspaceRoot(): string {
  return dirname(
    dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url))))),
  );
}

function resolveWebAppRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "apps", "web");
}

function resolveViteCliPath(webAppRoot: string): string {
  return Deno.realPathSync(join(webAppRoot, "node_modules", ".bin", "vite"));
}

function toShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function toPowerShellEncodedCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i += 1) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  return btoa(String.fromCharCode(...bytes));
}

export class DenoDetachedWebLauncher implements WebProcessLauncherLike {
  constructor(
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly workspaceRoot: string = resolveWorkspaceRoot(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
    private readonly preferPowerShellStartProcessOnWindows: boolean = true,
  ) {}

  private launchDetachedViaShell(
    args: string[],
    workingDirectory: string,
  ): Promise<number> {
    const quotedCommand = [this.denoExecPath, ...args].map(
      toShellSingleQuoted,
    ).join(" ");
    const script = `cd ${
      toShellSingleQuoted(workingDirectory)
    } && if command -v setsid >/dev/null 2>&1; then setsid ${quotedCommand} >/dev/null 2>&1 < /dev/null & else nohup ${quotedCommand} >/dev/null 2>&1 < /dev/null & fi; printf '%s\\n' $!`;
    const command = this.commandFactory("sh", {
      args: ["-lc", script],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: { CI: "true" },
    });
    if (typeof command.output !== "function") {
      throw new Error(
        "Detached shell launcher requires commandFactory output() support",
      );
    }
    return command.output().then((result) => {
      if (result.code !== 0) {
        const errorText = new TextDecoder().decode(result.stderr).trim();
        throw new Error(
          `Detached shell launch failed (exit ${result.code}): ${errorText}`,
        );
      }
      const stdoutText = new TextDecoder().decode(result.stdout).trim();
      const pid = Number.parseInt(stdoutText, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(
          `Detached shell launch did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  private launchDetachedViaPowerShell(
    args: string[],
    workingDirectory: string,
  ): Promise<number> {
    const argList = args.map(toPowerShellSingleQuoted).join(", ");
    const script = `$ErrorActionPreference = 'Stop';
$argList = @(${argList});
$proc = Start-Process -FilePath ${
      toPowerShellSingleQuoted(this.denoExecPath)
    } -ArgumentList $argList -WorkingDirectory ${
      toPowerShellSingleQuoted(workingDirectory)
    } -WindowStyle Hidden -PassThru;
[Console]::Out.WriteLine($proc.Id);`;
    const encodedCommand = toPowerShellEncodedCommand(script);
    const command = this.commandFactory("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedCommand,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: { CI: "true" },
    });
    if (typeof command.output !== "function") {
      throw new Error(
        "Detached PowerShell launcher requires commandFactory output() support",
      );
    }
    return command.output().then((result) => {
      if (result.code !== 0) {
        const errorText = new TextDecoder().decode(result.stderr).trim();
        throw new Error(
          `PowerShell Start-Process launch failed (exit ${result.code}): ${errorText}`,
        );
      }
      const stdoutText = new TextDecoder().decode(result.stdout).trim();
      const pid = Number.parseInt(stdoutText, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error(
          `PowerShell Start-Process did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  async launchDetached(
    options: { hostname: string; port: number },
  ): Promise<number> {
    const webAppRoot = resolveWebAppRoot(this.workspaceRoot);
    const viteCliPath = resolveViteCliPath(webAppRoot);
    const args = [
      "run",
      "--ext=js",
      "-A",
      viteCliPath,
      "--host",
      options.hostname,
      "--port",
      String(options.port),
    ];

    if (
      this.preferPowerShellStartProcessOnWindows &&
      Deno.build.os === "windows"
    ) {
      return this.launchDetachedViaPowerShell(args, webAppRoot);
    }

    return this.launchDetachedViaShell(args, webAppRoot);
  }
}
