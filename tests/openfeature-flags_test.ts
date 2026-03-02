import { assertEquals } from "@std/assert";
import {
  bootstrapOpenFeature,
  createDefaultDaemonFeatureFlags,
  evaluateDaemonFeatureSettings,
} from "../apps/daemon/src/mod.ts";

Deno.test("OpenFeature bootstrap uses deterministic local defaults", () => {
  const client = bootstrapOpenFeature();
  const settings = evaluateDaemonFeatureSettings(client, {
    provider: "codex",
    sessionId: "session-1",
  });

  assertEquals(settings.exportEnabled, true);
  assertEquals(settings.captureIncludeSystemEvents, false);
});

Deno.test("OpenFeature bootstrap applies local overrides", () => {
  const defaults = createDefaultDaemonFeatureFlags();
  const client = bootstrapOpenFeature({
    ...defaults,
    daemonExportEnabled: false,
    captureIncludeSystemEvents: true,
  });
  const settings = evaluateDaemonFeatureSettings(client, {
    provider: "claude",
    sessionId: "session-2",
  });

  assertEquals(settings.exportEnabled, false);
  assertEquals(settings.captureIncludeSystemEvents, true);
});
