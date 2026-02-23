import { dirname, fromFileUrl } from "@std/path";
import type { DaemonCliRuntime } from "../cli/types.ts";

export interface DaemonProcessLauncherLike {
  launchDetached(): Promise<number>;
}

function resolveDaemonMainPath(): string {
  return fromFileUrl(new URL("../main.ts", import.meta.url));
}

type DenoCommandOptions = ConstructorParameters<typeof Deno.Command>[1];
type CommandLike = { spawn(): { pid: number } };
type DenoCommandFactory = (
  command: string,
  options: DenoCommandOptions,
) => CommandLike;

export class DenoDetachedDaemonLauncher implements DaemonProcessLauncherLike {
  constructor(
    private readonly runtime: DaemonCliRuntime,
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly daemonMainPath: string = resolveDaemonMainPath(),
    private readonly commandFactory: DenoCommandFactory = (command, options) =>
      new Deno.Command(command, options),
  ) {}

  launchDetached(): Promise<number> {
    const writeRoots = new Set<string>([
      ...(this.runtime.allowedWriteRoots ?? []),
      this.runtime.runtimeDir,
      dirname(this.runtime.configPath),
      dirname(this.runtime.statusPath),
      dirname(this.runtime.controlPath),
    ]);
    const readRoots = new Set<string>([
      ...writeRoots,
      ...(this.runtime.providerSessionRoots?.claude ?? []),
      ...(this.runtime.providerSessionRoots?.codex ?? []),
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
      },
    });
    const child = command.spawn();
    return Promise.resolve(child.pid);
  }
}
