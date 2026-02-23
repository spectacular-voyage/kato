import { assertEquals } from "@std/assert";
import {
  bootstrapOpenFeature,
  createDefaultRuntimeFeatureFlags,
  evaluateDaemonFeatureSettings,
} from "../apps/daemon/src/mod.ts";

Deno.test("OpenFeature bootstrap uses deterministic local defaults", () => {
  const client = bootstrapOpenFeature();
  const settings = evaluateDaemonFeatureSettings(client, {
    provider: "codex",
    sessionId: "session-1",
  });

  assertEquals(settings.exportEnabled, true);
  assertEquals(settings.writerRenderOptions, {
    includeThinking: true,
    includeToolCalls: true,
    italicizeUserMessages: false,
  });
});

Deno.test("OpenFeature bootstrap applies local overrides", () => {
  const defaults = createDefaultRuntimeFeatureFlags();
  const client = bootstrapOpenFeature({
    ...defaults,
    daemonExportEnabled: false,
    writerIncludeThinking: false,
    writerIncludeToolCalls: false,
    writerItalicizeUserMessages: true,
  });
  const settings = evaluateDaemonFeatureSettings(client, {
    provider: "claude",
    sessionId: "session-2",
  });

  assertEquals(settings.exportEnabled, false);
  assertEquals(settings.writerRenderOptions, {
    includeThinking: false,
    includeToolCalls: false,
    italicizeUserMessages: true,
  });
});
