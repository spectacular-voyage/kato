import { dirname } from "@std/path";

export interface DaemonControlState {
  daemonRunning: boolean;
  daemonPid?: number;
  startedAt?: string;
  updatedAt: string;
}

export interface DaemonControlStateStoreLike {
  load(): Promise<DaemonControlState>;
  save(state: DaemonControlState): Promise<void>;
}

function isDaemonControlState(value: unknown): value is DaemonControlState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record["daemonRunning"] !== "boolean") {
    return false;
  }
  if (typeof record["updatedAt"] !== "string") {
    return false;
  }

  const daemonPid = record["daemonPid"];
  if (daemonPid !== undefined && typeof daemonPid !== "number") {
    return false;
  }

  const startedAt = record["startedAt"];
  if (startedAt !== undefined && typeof startedAt !== "string") {
    return false;
  }

  return true;
}

export function resolveDefaultStatePath(): string {
  try {
    return Deno.env.get("KATO_DAEMON_STATE_PATH") ??
      ".kato/runtime/daemon-state.json";
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      return ".kato/runtime/daemon-state.json";
    }
    throw error;
  }
}

export class DaemonControlStateStore implements DaemonControlStateStoreLike {
  constructor(
    private readonly statePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private makeDefaultState(): DaemonControlState {
    return {
      daemonRunning: false,
      updatedAt: this.now().toISOString(),
    };
  }

  async load(): Promise<DaemonControlState> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.statePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return this.makeDefaultState();
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isDaemonControlState(parsed)) {
        return parsed;
      }
      return this.makeDefaultState();
    } catch {
      return this.makeDefaultState();
    }
  }

  async save(state: DaemonControlState): Promise<void> {
    const dir = dirname(this.statePath);
    await Deno.mkdir(dir, { recursive: true });

    const tmpPath = `${this.statePath}.tmp`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(state, null, 2));
    await Deno.rename(tmpPath, this.statePath);
  }
}
