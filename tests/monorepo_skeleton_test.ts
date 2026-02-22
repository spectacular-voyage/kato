import { assertEquals } from "@std/assert";
import {
  createBootstrapStatusSnapshot,
  describeDaemonEntryPoint,
} from "../apps/daemon/src/mod.ts";
import { toStatusAggregationRecord } from "../apps/cloud/src/mod.ts";
import { toStatusViewModel } from "../apps/web/src/mod.ts";

Deno.test("daemon status snapshot converts into web/cloud models", () => {
  const snapshot = createBootstrapStatusSnapshot();
  const view = toStatusViewModel(snapshot);
  const record = toStatusAggregationRecord("node-local", snapshot);

  assertEquals(
    describeDaemonEntryPoint(),
    "kato daemon entry point (launcher -> orchestrator)",
  );
  assertEquals(view.daemon, "stopped");
  assertEquals(view.sessionCount, 0);
  assertEquals(record.sourceNodeId, "node-local");
  assertEquals(record.snapshot.daemonRunning, false);
});
