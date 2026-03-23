import type { RuntimeConfig } from "@kato/shared";
import { join } from "@std/path";
import {
  createDefaultRuntimeConfig,
  resolveDefaultConfigPath,
  RuntimeConfigFileStore,
} from "../../../runtime/src/config/runtime_config.ts";
import { resolveDefaultRuntimeDir } from "../../../runtime/src/orchestrator/control_plane.ts";

export interface LoadRuntimeConfigOrDefaultOptions {
  katoDir?: string;
  runtimeDir?: string;
}

export async function loadRuntimeConfigOrDefault(
  options: LoadRuntimeConfigOrDefaultOptions = {},
): Promise<RuntimeConfig> {
  const runtimeDir = options.runtimeDir ??
    (options.katoDir
      ? join(options.katoDir, "daemon")
      : resolveDefaultRuntimeDir());
  const configPath = resolveDefaultConfigPath(runtimeDir);
  const store = new RuntimeConfigFileStore(configPath);
  try {
    return await store.load();
  } catch {
    return createDefaultRuntimeConfig({
      runtimeDir,
      ...(options.katoDir ? { katoDir: options.katoDir } : {}),
    });
  }
}
