import { dirname, fromFileUrl, join } from "@std/path";
import type { ProviderSessionRoots } from "@kato/shared";
import { resolveHomeDir } from "../utils/env.ts";

export interface DaemonProcessLauncherLike {
  launchDetached(): Promise<number>;
}

export interface DaemonLauncherRuntime {
  runtimeDir: string;
  configPath: string;
  statusPath: string;
  controlPath: string;
  allowedWriteRoots?: string[];
  providerSessionRoots?: ProviderSessionRoots;
}

function resolveDaemonMainPath(): string {
  return join(
    dirname(fromFileUrl(import.meta.url)),
    "..",
    "..",
    "..",
    "daemon",
    "src",
    "main.ts",
  );
}

function resolveWorkspaceSourceRoot(daemonMainPath: string): string {
  // daemonMainPath is expected at <workspace>/apps/daemon/src/main.ts.
  // The detached subprocess needs read access to source modules imported from
  // apps/runtime and shared, so include workspace root in --allow-read.
  return dirname(dirname(dirname(dirname(daemonMainPath))));
}

function resolveUserConfigDir(): string | undefined {
  const home = resolveHomeDir();
  if (!home) {
    return undefined;
  }
  return join(home, ".kato");
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

export interface DetachedDaemonLauncherOptions {
  installedExecutablePath?: string;
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

export class DenoDetachedDaemonLauncher implements DaemonProcessLauncherLike {
  constructor(
    private readonly runtime: DaemonLauncherRuntime,
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly daemonMainPath: string = resolveDaemonMainPath(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
    private readonly preferPowerShellStartProcessOnWindows: boolean = true,
    private readonly options: DetachedDaemonLauncherOptions = {},
  ) {}

  private launchDetachedViaPowerShell(
    executablePath: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<number> {
    const envAssignments = Object.entries(env).map(([key, value]) =>
      `$env:${key}=${toPowerShellSingleQuoted(value)}`
    ).join(";\n");
    const argList = args.map(toPowerShellSingleQuoted).join(", ");
    const script = `$ErrorActionPreference = 'Stop';
${envAssignments};
$argList = @(${argList});
$proc = Start-Process -FilePath ${
      toPowerShellSingleQuoted(executablePath)
    } -ArgumentList $argList -WindowStyle Hidden -PassThru;
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

  launchDetached(): Promise<number> {
    const env = {
      KATO_RUNTIME_DIR: this.runtime.runtimeDir,
      KATO_CONFIG_PATH: this.runtime.configPath,
      KATO_DAEMON_STATUS_PATH: this.runtime.statusPath,
      KATO_DAEMON_CONTROL_PATH: this.runtime.controlPath,
      KATO_ALLOWED_WRITE_ROOTS_JSON: JSON.stringify(
        this.runtime.allowedWriteRoots ?? [],
      ),
      KATO_CLAUDE_SESSION_ROOTS: JSON.stringify(
        this.runtime.providerSessionRoots?.claude ?? [],
      ),
      KATO_CODEX_SESSION_ROOTS: JSON.stringify(
        this.runtime.providerSessionRoots?.codex ?? [],
      ),
      KATO_GEMINI_SESSION_ROOTS: JSON.stringify(
        this.runtime.providerSessionRoots?.gemini ?? [],
      ),
    };

    const installedExecutablePath = this.options.installedExecutablePath;
    if (installedExecutablePath) {
      if (
        this.preferPowerShellStartProcessOnWindows &&
        Deno.build.os === "windows"
      ) {
        return this.launchDetachedViaPowerShell(
          installedExecutablePath,
          [],
          env,
        );
      }

      const command = this.commandFactory(installedExecutablePath, {
        args: [],
        stdin: "null",
        stdout: "null",
        stderr: "inherit",
        env,
      });
      const child = command.spawn();
      return Promise.resolve(child.pid);
    }

    const workspaceSourceRoot = resolveWorkspaceSourceRoot(this.daemonMainPath);
    const userConfigDir = resolveUserConfigDir();
    const writeRoots = new Set<string>([
      ...(this.runtime.allowedWriteRoots ?? []),
      this.runtime.runtimeDir,
      dirname(this.runtime.configPath),
      dirname(this.runtime.statusPath),
      dirname(this.runtime.controlPath),
    ]);
    const readRoots = new Set<string>([
      ...writeRoots,
      this.daemonMainPath,
      dirname(this.daemonMainPath),
      workspaceSourceRoot,
      ...(userConfigDir ? [userConfigDir] : []),
      ...(this.runtime.providerSessionRoots?.claude ?? []),
      ...(this.runtime.providerSessionRoots?.codex ?? []),
      ...(this.runtime.providerSessionRoots?.gemini ?? []),
    ]);

    const args = [
      "run",
      `--allow-read=${Array.from(readRoots).join(",")}`,
      `--allow-write=${Array.from(writeRoots).join(",")}`,
      "--allow-env",
      this.daemonMainPath,
      "__daemon-run",
    ];

    if (
      this.preferPowerShellStartProcessOnWindows &&
      Deno.build.os === "windows"
    ) {
      return this.launchDetachedViaPowerShell(this.denoExecPath, args, env);
    }

    const command = this.commandFactory(this.denoExecPath, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
      env,
    });
    const child = command.spawn();
    return Promise.resolve(child.pid);
  }
}
