import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import type { RuntimeConfig } from "@kato/shared";
import { getKatoDir } from "../apps/cli/src/commands/workspace_shared.ts";
import { resolveTestTempPath } from "./test_temp.ts";

const WORKSPACE_SHARED_RUNTIME_DIR = resolveTestTempPath("kato", "runtime");
const WORKSPACE_SHARED_CLAUDE_DIR = resolveTestTempPath("sessions", "claude");
const WORKSPACE_SHARED_CODEX_DIR = resolveTestTempPath("sessions", "codex");
const WORKSPACE_SHARED_GEMINI_DIR = resolveTestTempPath("sessions", "gemini");
const WORKSPACE_SHARED_CUSTOM_KATO_DIR = resolveTestTempPath("custom-kato");
const WORKSPACE_SHARED_FALLBACK_KATO_DIR = resolveTestTempPath(
  "fallback-kato",
  "daemon",
);

function makeRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    schemaVersion: 1,
    runtimeDir: WORKSPACE_SHARED_RUNTIME_DIR,
    providerSessionRoots: {
      claude: [WORKSPACE_SHARED_CLAUDE_DIR],
      codex: [WORKSPACE_SHARED_CODEX_DIR],
      gemini: [WORKSPACE_SHARED_GEMINI_DIR],
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
    katoDir: WORKSPACE_SHARED_CUSTOM_KATO_DIR,
    runtimeDir: WORKSPACE_SHARED_RUNTIME_DIR,
  });
  assertEquals(getKatoDir(runtimeConfig), WORKSPACE_SHARED_CUSTOM_KATO_DIR);
});

Deno.test("getKatoDir falls back to runtimeDir parent when katoDir is unset", () => {
  const runtimeConfig = makeRuntimeConfig({
    runtimeDir: WORKSPACE_SHARED_FALLBACK_KATO_DIR,
    katoDir: undefined,
  });
  assertEquals(getKatoDir(runtimeConfig), dirname(runtimeConfig.runtimeDir));
});
