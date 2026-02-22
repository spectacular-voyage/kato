import { CliUsageError } from "./errors.ts";
import { parseDaemonCliArgs } from "./parser.ts";
import { getCommandUsage, getGlobalUsage } from "./usage.ts";
import type { DaemonCliRuntime } from "./types.ts";
import {
  DaemonControlRequestFileStore,
  type DaemonControlRequestStoreLike,
  DaemonStatusSnapshotFileStore,
  type DaemonStatusSnapshotStoreLike,
  resolveDefaultControlPath,
  resolveDefaultRuntimeDir,
  resolveDefaultStatusPath,
} from "../orchestrator/mod.ts";
import {
  AuditLogger,
  NoopSink,
  StructuredLogger,
} from "../observability/mod.ts";
import {
  runCleanCommand,
  runExportCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
} from "./commands/mod.ts";

export interface RunDaemonCliOptions {
  runtime?: Partial<DaemonCliRuntime>;
  statusStore?: DaemonStatusSnapshotStoreLike;
  controlStore?: DaemonControlRequestStoreLike;
  operationalLogger?: StructuredLogger;
  auditLogger?: AuditLogger;
}

function writeToStream(
  stream: { writeSync(data: Uint8Array): number },
  text: string,
): void {
  const encoder = new TextEncoder();
  stream.writeSync(encoder.encode(text));
}

export function createDefaultCliRuntime(): DaemonCliRuntime {
  const runtimeDir = resolveDefaultRuntimeDir();
  return {
    runtimeDir,
    statusPath: resolveDefaultStatusPath(runtimeDir),
    controlPath: resolveDefaultControlPath(runtimeDir),
    now: () => new Date(),
    pid: Deno.pid,
    writeStdout: (text) => writeToStream(Deno.stdout, text),
    writeStderr: (text) => writeToStream(Deno.stderr, text),
  };
}

function buildRuntime(
  overrides: Partial<DaemonCliRuntime> | undefined,
): DaemonCliRuntime {
  const defaults = createDefaultCliRuntime();
  return {
    ...defaults,
    ...overrides,
  };
}

function renderUsage(topic?: Parameters<typeof getCommandUsage>[0]): string {
  if (topic) {
    return getCommandUsage(topic);
  }
  return getGlobalUsage();
}

export async function runDaemonCli(
  args: string[],
  options: RunDaemonCliOptions = {},
): Promise<number> {
  const runtime = buildRuntime(options.runtime);
  const statusStore = options.statusStore ??
    new DaemonStatusSnapshotFileStore(runtime.statusPath, runtime.now);
  const controlStore = options.controlStore ??
    new DaemonControlRequestFileStore(runtime.controlPath, runtime.now);

  const operationalLogger = options.operationalLogger ??
    new StructuredLogger([new NoopSink()], {
      channel: "operational",
      minLevel: "info",
      now: runtime.now,
    });

  const auditLogger = options.auditLogger ??
    new AuditLogger(
      new StructuredLogger([new NoopSink()], {
        channel: "security-audit",
        minLevel: "info",
        now: runtime.now,
      }),
    );

  let intent;
  try {
    intent = parseDaemonCliArgs(args);
  } catch (error) {
    if (error instanceof CliUsageError) {
      runtime.writeStderr(`${error.message}\n\n`);
      runtime.writeStderr(`${getGlobalUsage()}\n`);
      return 2;
    }
    throw error;
  }

  if (intent.kind === "help") {
    runtime.writeStdout(`${renderUsage(intent.topic)}\n`);
    return 0;
  }

  const commandContext = {
    runtime,
    statusStore,
    controlStore,
    operationalLogger,
    auditLogger,
  };

  try {
    switch (intent.command.name) {
      case "start":
        await runStartCommand(commandContext);
        return 0;
      case "stop":
        await runStopCommand(commandContext);
        return 0;
      case "status":
        await runStatusCommand(commandContext, intent.command.asJson);
        return 0;
      case "export":
        await runExportCommand(
          commandContext,
          intent.command.sessionId,
          intent.command.outputPath,
        );
        return 0;
      case "clean":
        await runCleanCommand(commandContext, {
          all: intent.command.all,
          dryRun: intent.command.dryRun,
          recordingsDays: intent.command.recordingsDays,
          sessionsDays: intent.command.sessionsDays,
        });
        return 0;
    }
  } catch (error) {
    runtime.writeStderr(
      `Command failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}
