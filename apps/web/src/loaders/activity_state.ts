import type { RuntimeConfig } from "@kato/shared";
import {
  createDefaultRuntimeConfig,
  resolveDefaultConfigPath,
  RuntimeConfigFileStore,
} from "../../../runtime/src/config/runtime_config.ts";
import { resolveDefaultRuntimeDir } from "../../../runtime/src/orchestrator/control_plane.ts";

export async function loadRuntimeConfigOrDefault(): Promise<RuntimeConfig> {
  const runtimeDir = resolveDefaultRuntimeDir();
  const configPath = resolveDefaultConfigPath(runtimeDir);
  const store = new RuntimeConfigFileStore(configPath);
  try {
    return await store.load();
  } catch {
    return createDefaultRuntimeConfig({ runtimeDir });
  }
}
