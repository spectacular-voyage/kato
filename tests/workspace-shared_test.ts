import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import type { RuntimeConfig } from "@kato/shared";
import { getKatoDir } from "../apps/cli/src/commands/workspace_shared.ts";

function makeRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir: "/tmp/kato/runtime",
    providerSessionRoots: {
      claude: ["/tmp/sessions/claude"],
      codex: ["/tmp/sessions/codex"],
      gemini: ["/tmp/sessions/gemini"],
    },
    daemonFeatureFlags: {
      daemonExportEnabled: false,
      captureIncludeSystemEvents: false,
    },
    logging: {
      operationalLevel: "info",
      auditLevel: "info",
    },
    daemonMaxMemoryMb: 200,
    ...overrides,
  };
}

Deno.test("getKatoDir returns explicit runtimeConfig.katoDir when present", () => {
  const runtimeConfig = makeRuntimeConfig({
    katoDir: "/tmp/custom-kato",
    runtimeDir: "/tmp/kato/runtime",
  });
  assertEquals(getKatoDir(runtimeConfig), "/tmp/custom-kato");
});

Deno.test("getKatoDir falls back to runtimeDir parent when katoDir is unset", () => {
  const runtimeConfig = makeRuntimeConfig({
    runtimeDir: "/tmp/fallback-kato/daemon",
    katoDir: undefined,
  });
  assertEquals(getKatoDir(runtimeConfig), dirname(runtimeConfig.runtimeDir));
});
