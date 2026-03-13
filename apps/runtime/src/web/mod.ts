import { dirname, fromFileUrl, join } from "@std/path";
import { writeTextAtomically } from "../config/file_store_utils.ts";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";

const WEB_STATUS_FILENAME = "kato-web-status.json";
const WEB_STATUS_SCHEMA_VERSION = 1;
const WINDOWS_POWERSHELL_PROBE_CACHE_TTL_MS = 250;
const UTF8_DECODER = new TextDecoder();

type CachedPowerShellResult = {
  expiresAtMs: number;
  result: Deno.CommandOutput;
};

const windowsProcessAliveCache = new Map<number, CachedPowerShellResult>();

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

function runPowerShellSync(script: string): Deno.CommandOutput {
  const encodedCommand = toPowerShellEncodedCommand(script);
  return new Deno.Command("powershell.exe", {
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
  }).outputSync();
}

function runWindowsProcessAliveProbe(pid: number): Deno.CommandOutput {
  const now = Date.now();
  const cached = windowsProcessAliveCache.get(pid);
  if (cached && cached.expiresAtMs > now) {
    return cached.result;
  }
  if (cached) {
    windowsProcessAliveCache.delete(pid);
  }

  const result = runPowerShellSync(
    `$ErrorActionPreference = 'Stop';
$proc = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue;
if ($null -eq $proc) {
  exit 1
}
exit 0`,
  );
  windowsProcessAliveCache.set(pid, {
    expiresAtMs: now + WINDOWS_POWERSHELL_PROBE_CACHE_TTL_MS,
    result,
  });
  return result;
}

function isWindowsProcessAlive(pid: number): boolean {
  try {
    const result = runWindowsProcessAliveProbe(pid);
    return result.code === 0;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (Deno.build.os === "windows") {
    // Windows does not support `kill(pid, 0)` probes, so use tasklist.
    return isWindowsProcessAlive(pid);
  }
  try {
    Deno.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateWindowsProcess(pid: number, force: boolean): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`Invalid Windows process id: ${pid}`);
  }

  const validatedPid = pid;
  const safePid = String(validatedPid);
  const shouldForce = force === true;
  windowsProcessAliveCache.delete(validatedPid);

  try {
    const result = runPowerShellSync(
      `$ErrorActionPreference = 'Stop';
$proc = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue;
if ($null -eq $proc) {
  exit 0
}
Stop-Process -Id ${safePid}${shouldForce ? " -Force" : ""} -ErrorAction Stop;
exit 0`,
    );
    if (result.code === 0) {
      return;
    }

    const errorText = UTF8_DECODER.decode(result.stderr).trim();
    throw new Error(
      errorText.length > 0
        ? `Failed to stop Windows process ${validatedPid}: ${errorText}`
        : `Failed to stop Windows process ${validatedPid} (exit ${result.code})`,
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
}

export function terminateProcess(
  pid: number | undefined,
  force: boolean = false,
): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  if (Deno.build.os === "windows") {
    terminateWindowsProcess(pid, force);
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    Deno.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
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

export interface DetachedWebLauncherOptions {
  installedExecutablePath?: string;
}

function resolveWorkspaceRoot(): string {
  return dirname(
    dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url))))),
  );
}

function resolveWebAppRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "apps", "web");
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

function parseDetachedPid(stdoutText: string): number | undefined {
  const lines = stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/^\d+$/.test(line)) {
      continue;
    }
    const pid = Number.parseInt(line, 10);
    if (Number.isFinite(pid) && pid > 0) {
      return pid;
    }
  }
  return undefined;
}

export class DenoDetachedWebLauncher implements WebProcessLauncherLike {
  constructor(
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly workspaceRoot: string = resolveWorkspaceRoot(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
    private readonly preferPowerShellStartProcessOnWindows: boolean = true,
    private readonly options: DetachedWebLauncherOptions = {},
  ) {}

  private launchDetachedViaShell(
    executablePath: string,
    args: string[],
    workingDirectory: string,
  ): Promise<number> {
    const quotedCommand = [executablePath, ...args].map(
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
      const pid = parseDetachedPid(stdoutText);
      if (pid === undefined) {
        throw new Error(
          `Detached shell launch did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  private launchDetachedScriptViaShell(script: string): Promise<number> {
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
      const pid = parseDetachedPid(stdoutText);
      if (pid === undefined) {
        throw new Error(
          `Detached shell launch did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  private launchDetachedViaPowerShell(
    executablePath: string,
    args: string[],
    workingDirectory: string,
  ): Promise<number> {
    const startProcessArgs = args.length > 0
      ? `$argList = @(${args.map(toPowerShellSingleQuoted).join(", ")});
$proc = Start-Process -FilePath ${
        toPowerShellSingleQuoted(executablePath)
      } -ArgumentList $argList -WorkingDirectory ${
        toPowerShellSingleQuoted(workingDirectory)
      } -WindowStyle Hidden -PassThru;`
      : `$proc = Start-Process -FilePath ${
        toPowerShellSingleQuoted(executablePath)
      } -WorkingDirectory ${
        toPowerShellSingleQuoted(workingDirectory)
      } -WindowStyle Hidden -PassThru;`;
    const script = `$ErrorActionPreference = 'Stop';
${startProcessArgs}
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
      const pid = parseDetachedPid(stdoutText);
      if (pid === undefined) {
        throw new Error(
          `PowerShell Start-Process did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  private launchDetachedScriptViaPowerShell(script: string): Promise<number> {
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
      const pid = parseDetachedPid(stdoutText);
      if (pid === undefined) {
        throw new Error(
          `PowerShell Start-Process did not return a valid PID: '${stdoutText}'`,
        );
      }
      return pid;
    });
  }

  launchDetached(
    options: { hostname: string; port: number },
  ): Promise<number> {
    const installedExecutablePath = this.options.installedExecutablePath;
    const webAppRoot = installedExecutablePath
      ? dirname(installedExecutablePath)
      : resolveWebAppRoot(this.workspaceRoot);
    const executablePath = installedExecutablePath ?? this.denoExecPath;
    const installedArgs = [
      "--host",
      options.hostname,
      "--port",
      String(options.port),
    ];

    if (
      this.preferPowerShellStartProcessOnWindows &&
      Deno.build.os === "windows"
    ) {
      if (!installedExecutablePath) {
        const script = `$ErrorActionPreference = 'Stop';
Set-Location ${toPowerShellSingleQuoted(webAppRoot)};
& ${
          toPowerShellSingleQuoted(executablePath)
        } 'run' '--node-modules-dir=auto' '--ext=js' '-A' 'vite' 'build';
if ($LASTEXITCODE -ne 0) {
  throw "vite build failed with exit code $LASTEXITCODE"
}
$argList = @('serve', '--node-modules-dir=auto', '-A', '--host', ${
          toPowerShellSingleQuoted(options.hostname)
        }, '--port', ${
          toPowerShellSingleQuoted(String(options.port))
        }, '_fresh/server.js');
$proc = Start-Process -FilePath ${
          toPowerShellSingleQuoted(executablePath)
        } -ArgumentList $argList -WorkingDirectory ${
          toPowerShellSingleQuoted(webAppRoot)
        } -WindowStyle Hidden -PassThru;
[Console]::Out.WriteLine($proc.Id);`;
        return this.launchDetachedScriptViaPowerShell(script);
      }
      return this.launchDetachedViaPowerShell(
        executablePath,
        installedArgs,
        webAppRoot,
      );
    }

    if (!installedExecutablePath) {
      const quotedBuildCommand = [
        executablePath,
        "run",
        "--node-modules-dir=auto",
        "--ext=js",
        "-A",
        "vite",
        "build",
      ].map(toShellSingleQuoted).join(" ");
      const quotedServeCommand = [
        executablePath,
        "serve",
        "--node-modules-dir=auto",
        "-A",
        "--host",
        options.hostname,
        "--port",
        String(options.port),
        "_fresh/server.js",
      ].map(toShellSingleQuoted).join(" ");
      const script = `cd ${
        toShellSingleQuoted(webAppRoot)
      } && ${quotedBuildCommand} >/dev/null && if command -v setsid >/dev/null 2>&1; then setsid ${quotedServeCommand} >/dev/null 2>&1 < /dev/null & else nohup ${quotedServeCommand} >/dev/null 2>&1 < /dev/null & fi; printf '%s\\n' $!`;
      return this.launchDetachedScriptViaShell(script);
    }

    return this.launchDetachedViaShell(
      executablePath,
      installedArgs,
      webAppRoot,
    );
  }
}
