interface StoredWebEndpoint {
  hostname?: string;
  port?: number;
  url?: string;
}

interface ConfiguredWebEndpoint {
  hostname: string;
  port: number;
}

export interface ResolvedWebEndpoint {
  hostname?: string;
  port?: number;
  url?: string;
}

export function resolveWebEndpoint(
  stored: StoredWebEndpoint,
  config: ConfiguredWebEndpoint | undefined,
  alive: boolean,
  stale: boolean,
): ResolvedWebEndpoint {
  const useStoredEndpoint = alive || stale;
  const hostname = useStoredEndpoint
    ? stored.hostname ?? config?.hostname
    : config?.hostname ?? stored.hostname;
  const port = useStoredEndpoint
    ? stored.port ?? config?.port
    : config?.port ?? stored.port;
  const url = useStoredEndpoint
    ? stored.url ??
      (hostname && port ? `http://${hostname}:${port}/` : undefined)
    : config
    ? `http://${config.hostname}:${config.port}/`
    : stored.url;

  return { hostname, port, url };
}
