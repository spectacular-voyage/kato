import { fromFileUrl } from "@std/path";
import type { DaemonCliRuntime } from "../cli/types.ts";

export interface DaemonProcessLauncherLike {
  launchDetached(): Promise<number>;
}

function resolveDaemonMainPath(): string {
  return fromFileUrl(new URL("../main.ts", import.meta.url));
}

export class DenoDetachedDaemonLauncher implements DaemonProcessLauncherLike {
  constructor(
    private readonly runtime: DaemonCliRuntime,
    private readonly denoExecPath: string = Deno.execPath(),
    private readonly daemonMainPath: string = resolveDaemonMainPath(),
  ) {}

  launchDetached(): Promise<number> {
    const command = new Deno.Command(this.denoExecPath, {
      args: [
        "run",
        "--allow-read",
        "--allow-write=.kato",
        "--allow-env",
        this.daemonMainPath,
        "__daemon-run",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: {
        KATO_RUNTIME_DIR: this.runtime.runtimeDir,
        KATO_DAEMON_STATUS_PATH: this.runtime.statusPath,
        KATO_DAEMON_CONTROL_PATH: this.runtime.controlPath,
      },
    });
    const child = command.spawn();
    return Promise.resolve(child.pid);
  }
}
