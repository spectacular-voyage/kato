import { dirname, fromFileUrl, join } from "@std/path";
import { writeTextAtomically } from "../config/file_store_utils.ts";
import { resolveDefaultKatoDir } from "../orchestrator/session_state_store.ts";

const WEB_STATUS_FILENAME = "kato-web-status.json";
const WEB_STATUS_SCHEMA_VERSION = 1;
const WEB_STARTUP_STDOUT_LOG_FILENAME = "startup.stdout.log";
const WEB_STARTUP_STDERR_LOG_FILENAME = "startup.stderr.log";
const WINDOWS_HOST_PORT_PROBE_TIMEOUT_MS = 1_500;
const WINDOWS_POWERSHELL_PROBE_CACHE_TTL_MS = 250;
const DEFAULT_WEB_PORT_SCAN_LIMIT = 100;
const WSL_OS_RELEASE_PATH = "/proc/sys/kernel/osrelease";
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

export interface WebProcessLaunchResult {
  pid: number;
  buildLatencyMs?: number;
  startupStdoutLogPath?: string;
  startupStderrLogPath?: string;
}

export interface WebProcessLauncherLike {
  launchDetached(options: { hostname: string; port: number }): Promise<number>;
  launchDetachedDetailed?(
    options: { hostname: string; port: number },
  ): Promise<WebProcessLaunchResult>;
}

export interface WebPortSelectionOptions {
  hostname: string;
  preferredPort: number;
  maxAttempts?: number;
}

export interface WebPortSelectorLike {
  selectAvailablePort(options: WebPortSelectionOptions): Promise<number>;
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

export function resolveDefaultWebStartupStdoutLogPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "web", "logs", WEB_STARTUP_STDOUT_LOG_FILENAME);
}

export function resolveDefaultWebStartupStderrLogPath(
  katoDir: string = resolveDefaultKatoDir(),
): string {
  return join(katoDir, "web", "logs", WEB_STARTUP_STDERR_LOG_FILENAME);
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
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      return true;
    }
    throw error;
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
interface WebTcpListenOptions {
  hostname?: string;
  port: number;
  transport?: "tcp";
}
type DenoListenFactory = (options: WebTcpListenOptions) => Deno.Listener;

export interface SelectAvailableWebPortDeps {
  listen?: DenoListenFactory;
  readTextFile?: (path: string) => Promise<string>;
  commandFactory?: DenoCommandFactory;
  buildOs?: typeof Deno.build.os;
}

function validatePort(value: number, source: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Deno.errors.AddrInUse ||
    (error instanceof Error &&
      (error.name === "AddrInUse" ||
        error.message.toLowerCase().includes("address already in use")));
}

function canBindWebPort(
  hostname: string,
  port: number,
  listen: DenoListenFactory,
): boolean {
  let listener: Deno.Listener | undefined;
  try {
    listener = listen({ hostname, port, transport: "tcp" });
    return true;
  } catch (error) {
    if (isAddressInUseError(error)) {
      return false;
    }
    throw error;
  } finally {
    try {
      listener?.close();
    } catch {
      // The probe listener is best-effort and has no accepted connections.
    }
  }
}

function shouldProbeWindowsHostForPort(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::";
}

async function isWslLinuxHost(
  buildOs: typeof Deno.build.os,
  readTextFile: (path: string) => Promise<string>,
): Promise<boolean> {
  if (buildOs !== "linux") {
    return false;
  }
  try {
    return /microsoft|wsl/i.test(await readTextFile(WSL_OS_RELEASE_PATH));
  } catch {
    return false;
  }
}

function buildWindowsTcpListenerProbeScript(port: number): string {
  return `$ErrorActionPreference = 'Stop';
$port = ${port};
$listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners();
foreach ($listener in $listeners) {
  if ($listener.Port -eq $port) {
    exit 0
  }
}
exit 1`;
}

async function isWindowsHostPortListening(
  port: number,
  commandFactory: DenoCommandFactory,
): Promise<boolean> {
  const abortController = new AbortController();
  let command: CommandLike;
  try {
    command = commandFactory("powershell.exe", {
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        toPowerShellEncodedCommand(buildWindowsTcpListenerProbeScript(port)),
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: { CI: "true" },
      signal: abortController.signal,
    });
  } catch {
    return false;
  }

  if (typeof command.output !== "function") {
    return false;
  }

  let timeoutId: number | undefined;
  try {
    const output = await Promise.race([
      command.output().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          resolve(undefined);
        }, WINDOWS_HOST_PORT_PROBE_TIMEOUT_MS);
      }),
    ]);
    return output?.code === 0;
  } catch {
    return false;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export async function selectAvailableWebPort(
  options: WebPortSelectionOptions,
  deps: SelectAvailableWebPortDeps = {},
): Promise<number> {
  validatePort(options.preferredPort, "preferredPort");
  const maxAttempts = options.maxAttempts ?? DEFAULT_WEB_PORT_SCAN_LIMIT;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  const listen = deps.listen ?? ((listenOptions) => Deno.listen(listenOptions));
  const readTextFile = deps.readTextFile ?? ((path) => Deno.readTextFile(path));
  const commandFactory = deps.commandFactory ??
    ((command, commandOptions) => new Deno.Command(command, commandOptions));
  const buildOs = deps.buildOs ?? Deno.build.os;
  const shouldProbeWindowsHost = shouldProbeWindowsHostForPort(
    options.hostname,
  ) && await isWslLinuxHost(buildOs, readTextFile);
  const lastPort = Math.min(
    65_535,
    options.preferredPort + maxAttempts - 1,
  );

  for (let port = options.preferredPort; port <= lastPort; port += 1) {
    if (!canBindWebPort(options.hostname, port, listen)) {
      continue;
    }
    if (
      shouldProbeWindowsHost &&
      await isWindowsHostPortListening(port, commandFactory)
    ) {
      continue;
    }
    return port;
  }

  throw new Error(
    `No available Kato Web port found from ${options.preferredPort} through ${lastPort}`,
  );
}

export const defaultWebPortSelector: WebPortSelectorLike = {
  selectAvailablePort: selectAvailableWebPort,
};

export interface DetachedWebLauncherOptions {
  installedExecutablePath?: string;
  startupStdoutLogPath?: string;
  startupStderrLogPath?: string;
}

type WebStartupLogPaths = Pick<
  WebProcessLaunchResult,
  "startupStdoutLogPath" | "startupStderrLogPath"
>;

function resolveWorkspaceRoot(): string {
  return dirname(
    dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url))))),
  );
}

function resolveWebAppRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "apps", "web");
}

async function isSourceWebBuildCurrent(
  workspaceRoot: string,
  webAppRoot: string,
): Promise<boolean> {
  const outputStat = await statOptional(
    join(webAppRoot, "_fresh", "server.js"),
  );
  const outputMtimeMs = outputStat?.mtime?.getTime();
  if (!outputStat?.isFile || outputMtimeMs === undefined) {
    return false;
  }

  const sourceRoots = [
    webAppRoot,
    join(workspaceRoot, "apps", "runtime", "src"),
    join(workspaceRoot, "shared", "src"),
  ];

  for (const root of sourceRoots) {
    if (await hasFileNewerThan(root, outputMtimeMs)) {
      return false;
    }
  }
  return true;
}

async function statOptional(path: string): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

async function hasFileNewerThan(
  root: string,
  timestampMs: number,
): Promise<boolean> {
  const rootStat = await statOptional(root);
  if (!rootStat) {
    return false;
  }
  if (rootStat.isFile) {
    return (rootStat.mtime?.getTime() ?? 0) > timestampMs;
  }
  if (!rootStat.isDirectory) {
    return false;
  }

  for await (const entry of Deno.readDir(root)) {
    if (
      entry.name === "_fresh" ||
      entry.name === "node_modules" ||
      entry.name === ".git"
    ) {
      continue;
    }
    if (await hasFileNewerThan(join(root, entry.name), timestampMs)) {
      return true;
    }
  }
  return false;
}

function toShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function buildShellStartupRedirection(paths: WebStartupLogPaths): string {
  const stdout = paths.startupStdoutLogPath
    ? `> ${toShellSingleQuoted(paths.startupStdoutLogPath)}`
    : ">/dev/null";
  const stderr = paths.startupStderrLogPath
    ? `2> ${toShellSingleQuoted(paths.startupStderrLogPath)}`
    : "2>&1";
  return `${stdout} ${stderr}`;
}

function toWindowsCmdDoubleQuoted(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function hasStartupLogRedirection(paths: WebStartupLogPaths): boolean {
  return paths.startupStdoutLogPath !== undefined ||
    paths.startupStderrLogPath !== undefined;
}

function buildWindowsCmdRedirectCommand(
  executablePath: string,
  args: string[],
  paths: WebStartupLogPaths,
): string {
  const command = [executablePath, ...args].map(toWindowsCmdDoubleQuoted).join(
    " ",
  );
  const stdout = paths.startupStdoutLogPath
    ? `1> ${toWindowsCmdDoubleQuoted(paths.startupStdoutLogPath)}`
    : "1> NUL";
  const stderr = paths.startupStderrLogPath
    ? `2> ${toWindowsCmdDoubleQuoted(paths.startupStderrLogPath)}`
    : "2>&1";
  return `"${command} ${stdout} ${stderr}"`;
}

function buildPowerShellStartProcessScript(
  executablePath: string,
  args: string[],
  workingDirectory: string,
  startupLogPaths: WebStartupLogPaths,
): string {
  const useCmdRedirect = hasStartupLogRedirection(startupLogPaths);
  const filePath = useCmdRedirect ? "cmd.exe" : executablePath;
  const processArgs = useCmdRedirect
    ? [
      "/d",
      "/s",
      "/c",
      buildWindowsCmdRedirectCommand(executablePath, args, startupLogPaths),
    ]
    : args;

  if (processArgs.length === 0) {
    return `$proc = Start-Process -FilePath ${
      toPowerShellSingleQuoted(filePath)
    } -WorkingDirectory ${
      toPowerShellSingleQuoted(workingDirectory)
    } -WindowStyle Hidden -PassThru;`;
  }

  return `$argList = @(${processArgs.map(toPowerShellSingleQuoted).join(", ")});
$proc = Start-Process -FilePath ${
    toPowerShellSingleQuoted(filePath)
  } -ArgumentList $argList -WorkingDirectory ${
    toPowerShellSingleQuoted(workingDirectory)
  } -WindowStyle Hidden -PassThru;`;
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

function parseBuildLatencyMs(stdoutText: string): number | undefined {
  const match = stdoutText.match(/^KATO_BUILD_MS=(\d+)$/m);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
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
    startupLogPaths: WebStartupLogPaths = {},
  ): Promise<WebProcessLaunchResult> {
    const quotedCommand = [executablePath, ...args].map(
      toShellSingleQuoted,
    ).join(" ");
    const redirection = buildShellStartupRedirection(startupLogPaths);
    const script = `cd ${
      toShellSingleQuoted(workingDirectory)
    } && if command -v setsid >/dev/null 2>&1; then setsid ${quotedCommand} ${redirection} < /dev/null & else nohup ${quotedCommand} ${redirection} < /dev/null & fi; printf '%s\\n' $!`;
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
      return { pid, ...startupLogPaths };
    });
  }

  private launchDetachedScriptViaShell(
    script: string,
    startupLogPaths: WebStartupLogPaths = {},
  ): Promise<WebProcessLaunchResult> {
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
      return {
        pid,
        buildLatencyMs: parseBuildLatencyMs(stdoutText),
        ...startupLogPaths,
      };
    });
  }

  private launchDetachedViaPowerShell(
    executablePath: string,
    args: string[],
    workingDirectory: string,
    startupLogPaths: WebStartupLogPaths = {},
  ): Promise<WebProcessLaunchResult> {
    const startProcessArgs = buildPowerShellStartProcessScript(
      executablePath,
      args,
      workingDirectory,
      startupLogPaths,
    );
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
      return { pid, ...startupLogPaths };
    });
  }

  private launchDetachedScriptViaPowerShell(
    script: string,
    startupLogPaths: WebStartupLogPaths = {},
  ): Promise<WebProcessLaunchResult> {
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
      return {
        pid,
        buildLatencyMs: parseBuildLatencyMs(stdoutText),
        ...startupLogPaths,
      };
    });
  }

  private async prepareStartupLogPath(
    path: string | undefined,
  ): Promise<string | undefined> {
    if (!path) {
      return undefined;
    }
    try {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, "");
      return path;
    } catch {
      return undefined;
    }
  }

  private async prepareStartupLogs(): Promise<WebStartupLogPaths> {
    const [stdoutPath, stderrPath] = await Promise.all([
      this.prepareStartupLogPath(this.options.startupStdoutLogPath),
      this.prepareStartupLogPath(this.options.startupStderrLogPath),
    ]);
    return {
      ...(stdoutPath ? { startupStdoutLogPath: stdoutPath } : {}),
      ...(stderrPath ? { startupStderrLogPath: stderrPath } : {}),
    };
  }

  launchDetached(
    options: { hostname: string; port: number },
  ): Promise<number> {
    return this.launchDetachedDetailed(options).then((result) => result.pid);
  }

  async launchDetachedDetailed(
    options: { hostname: string; port: number },
  ): Promise<WebProcessLaunchResult> {
    const installedExecutablePath = this.options.installedExecutablePath;
    const webAppRoot = installedExecutablePath
      ? dirname(installedExecutablePath)
      : resolveWebAppRoot(this.workspaceRoot);
    const executablePath = installedExecutablePath ?? this.denoExecPath;
    const startupLogPaths = await this.prepareStartupLogs();
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
        const buildCurrent = await isSourceWebBuildCurrent(
          this.workspaceRoot,
          webAppRoot,
        );
        const buildScript = buildCurrent
          ? `[Console]::Out.WriteLine("KATO_BUILD_MS=0");`
          : `$buildStartedAt = Get-Date;
& ${
            toPowerShellSingleQuoted(executablePath)
          } 'run' '--node-modules-dir=auto' '--ext=js' '-A' 'vite' 'build';
if ($LASTEXITCODE -ne 0) {
  throw "vite build failed with exit code $LASTEXITCODE"
}
$buildLatencyMs = [int]((Get-Date) - $buildStartedAt).TotalMilliseconds;
[Console]::Out.WriteLine("KATO_BUILD_MS=$buildLatencyMs");`;
        const script = `$ErrorActionPreference = 'Stop';
Set-Location ${toPowerShellSingleQuoted(webAppRoot)};
${buildScript}
${
          buildPowerShellStartProcessScript(
            executablePath,
            [
              "serve",
              "--node-modules-dir=auto",
              "-A",
              "--host",
              options.hostname,
              "--port",
              String(options.port),
              "_fresh/server.js",
            ],
            webAppRoot,
            startupLogPaths,
          )
        }
[Console]::Out.WriteLine($proc.Id);`;
        return this.launchDetachedScriptViaPowerShell(script, startupLogPaths);
      }
      return this.launchDetachedViaPowerShell(
        executablePath,
        installedArgs,
        webAppRoot,
        startupLogPaths,
      );
    }

    if (!installedExecutablePath) {
      const buildCurrent = await isSourceWebBuildCurrent(
        this.workspaceRoot,
        webAppRoot,
      );
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
      const quotedEpochMsCommand = [
        executablePath,
        "eval",
        "console.log(Date.now())",
      ].map(toShellSingleQuoted).join(" ");
      const buildScript = buildCurrent
        ? "printf 'KATO_BUILD_MS=0\\n'"
        : `build_started_ms=$(${quotedEpochMsCommand}) && ${quotedBuildCommand} >/dev/null && build_finished_ms=$(${quotedEpochMsCommand}) && printf 'KATO_BUILD_MS=%s\\n' "$((build_finished_ms - build_started_ms))"`;
      const script = `cd ${
        toShellSingleQuoted(webAppRoot)
      } && ${buildScript} && if command -v setsid >/dev/null 2>&1; then setsid ${quotedServeCommand} ${
        buildShellStartupRedirection(startupLogPaths)
      } < /dev/null & else nohup ${quotedServeCommand} ${
        buildShellStartupRedirection(startupLogPaths)
      } < /dev/null & fi; printf '%s\\n' $!`;
      return this.launchDetachedScriptViaShell(script, startupLogPaths);
    }

    return this.launchDetachedViaShell(
      executablePath,
      installedArgs,
      webAppRoot,
      startupLogPaths,
    );
  }
}
