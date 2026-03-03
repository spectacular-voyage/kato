import denoConfig from "../deno.json" with { type: "json" };

function readVersion(config: unknown): string {
  if (
    typeof config === "object" &&
    config !== null &&
    "version" in config &&
    typeof (config as { version?: unknown }).version === "string"
  ) {
    const value = (config as { version: string }).version.trim();
    if (value.length > 0) {
      return value;
    }
  }

  return "0.0.0-dev";
}

export const DAEMON_APP_VERSION = readVersion(denoConfig);
