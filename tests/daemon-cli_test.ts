import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  CliUsageError,
  type DaemonControlState,
  type DaemonControlStateStoreLike,
  parseDaemonCliArgs,
  runDaemonCli,
} from "../apps/daemon/src/mod.ts";

function makeRuntimeHarness(statePath: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    runtime: {
      statePath,
      now: () => new Date("2026-02-22T10:00:00.000Z"),
      pid: 4242,
      writeStdout: (text: string) => {
        stdout.push(text);
      },
      writeStderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function makeInMemoryStateStore(
  initial: DaemonControlState = {
    daemonRunning: false,
    updatedAt: "2026-02-22T10:00:00.000Z",
  },
): DaemonControlStateStoreLike {
  let state = { ...initial };
  return {
    load() {
      return Promise.resolve({ ...state });
    },
    save(next: DaemonControlState) {
      state = { ...next };
      return Promise.resolve();
    },
  };
}

Deno.test("cli parser rejects unknown command", () => {
  assertThrows(
    () => parseDaemonCliArgs(["wat"]),
    CliUsageError,
    "Unknown command",
  );
});

Deno.test("cli parser rejects unknown flag", () => {
  assertThrows(
    () => parseDaemonCliArgs(["start", "--wat"]),
    CliUsageError,
    "Unknown flag",
  );
});

Deno.test("cli parser enforces clean action flags", () => {
  assertThrows(
    () => parseDaemonCliArgs(["clean"]),
    CliUsageError,
    "requires one of --all",
  );
});

Deno.test("cli parser accepts status --json", () => {
  const parsed = parseDaemonCliArgs(["status", "--json"]);
  assertEquals(parsed.kind, "command");
  if (parsed.kind !== "command") {
    return;
  }

  assertEquals(parsed.command.name, "status");
  if (parsed.command.name !== "status") {
    return;
  }

  assertEquals(parsed.command.asJson, true);
});

Deno.test("runDaemonCli start/status/stop round-trip", async () => {
  const stateStore = makeInMemoryStateStore();
  const statePath = ".kato/test-state.json";

  const startHarness = makeRuntimeHarness(statePath);
  const startCode = await runDaemonCli(["start"], {
    runtime: startHarness.runtime,
    stateStore,
  });
  assertEquals(startCode, 0);
  assertStringIncludes(startHarness.stdout.join(""), "marked as running");

  const statusHarness = makeRuntimeHarness(statePath);
  const statusCode = await runDaemonCli(["status", "--json"], {
    runtime: statusHarness.runtime,
    stateStore,
  });
  assertEquals(statusCode, 0);

  const statusPayload = JSON.parse(statusHarness.stdout.join("")) as {
    daemonRunning: boolean;
    daemonPid?: number;
  };
  assertEquals(statusPayload.daemonRunning, true);
  assertEquals(statusPayload.daemonPid, 4242);

  const stopHarness = makeRuntimeHarness(statePath);
  const stopCode = await runDaemonCli(["stop"], {
    runtime: stopHarness.runtime,
    stateStore,
  });
  assertEquals(stopCode, 0);
  assertStringIncludes(stopHarness.stdout.join(""), "marked as stopped");
});

Deno.test("runDaemonCli returns usage error code for unknown flag", async () => {
  const harness = makeRuntimeHarness(".kato/test-state.json");
  const code = await runDaemonCli(["start", "--bad-flag"], {
    runtime: harness.runtime,
    stateStore: makeInMemoryStateStore(),
  });

  assertEquals(code, 2);
  assertStringIncludes(harness.stderr.join(""), "Unknown flag");
});
