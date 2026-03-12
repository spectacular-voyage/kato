import { DEFAULT_KATO_WEB_HOSTNAME, DEFAULT_KATO_WEB_PORT } from "@kato/shared";

export type WebBinaryServeOptions = Pick<
  Deno.ServeTcpOptions,
  "hostname" | "port"
>;

function resolveHostname(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: string, source: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${source} must be an integer between 1 and 65535`);
  }
  return port;
}

export function parseWebBinaryServeOptions(
  args: string[],
  env: Record<string, string | undefined>,
): WebBinaryServeOptions {
  let hostname = resolveHostname(env.KATO_WEB_HOSTNAME) ??
    DEFAULT_KATO_WEB_HOSTNAME;
  let port = env.PORT ? parsePort(env.PORT, "PORT") : DEFAULT_KATO_WEB_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--host requires a value");
      }
      hostname = resolveHostname(value) ?? DEFAULT_KATO_WEB_HOSTNAME;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--port requires a value");
      }
      port = parsePort(value, "--port");
      index += 1;
      continue;
    }
    throw new Error(`Unsupported kato-web argument: ${arg}`);
  }

  return { hostname, port };
}
