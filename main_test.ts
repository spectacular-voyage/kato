import { assertEquals } from "@std/assert";
import { describeRuntime, describeWorkspaceLayout } from "./main.ts";

Deno.test(function runtimeTest() {
  assertEquals(
    describeRuntime(),
    "kato daemon entry point (launcher -> orchestrator)",
  );
});

Deno.test(function workspaceLayoutTest() {
  assertEquals(
    describeWorkspaceLayout(),
    "apps/cli, apps/daemon, apps/runtime, apps/web, apps/cloud, shared/src",
  );
});
