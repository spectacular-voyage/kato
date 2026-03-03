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
  return fromFileUrl(new URL("../../../daemon/src/main.ts", import.meta.url));
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
type CommandLike = { spawn(): { pid: number } };
type DenoCommandFactory = (
  command: string,
  options: DenoCommandOptions,
) => CommandLike;

export class DenoDetachedDaemonLauncher implements DaemonProcessLauncherLike {
  constructor(
    private readonly runtime: DaemonLauncherRuntime,
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly daemonMainPath: string = resolveDaemonMainPath(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
  ) {}

  launchDetached(): Promise<number> {
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

    const command = this.commandFactory(this.denoExecPath, {
      args: [
        "run",
        `--allow-read=${Array.from(readRoots).join(",")}`,
        `--allow-write=${Array.from(writeRoots).join(",")}`,
        "--allow-env",
        this.daemonMainPath,
        "__daemon-run",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: {
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
      },
    });
    const child = command.spawn();
    return Promise.resolve(child.pid);
  }
}
