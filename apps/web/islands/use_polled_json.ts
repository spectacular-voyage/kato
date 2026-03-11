import { useEffect, useState } from "preact/hooks";

export const LIVE_POLL_INTERVAL_MS = 2_000;

export function usePolledJson<T>(options: {
  initialData: T;
  endpoint: string;
  intervalMs?: number;
}): T {
  const intervalMs = options.intervalMs ?? LIVE_POLL_INTERVAL_MS;
  const [data, setData] = useState(options.initialData);

  useEffect(() => {
    setData(options.initialData);
  }, [options.initialData]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const load = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const response = await fetch(options.endpoint, {
          cache: "no-store",
        });
        if (!response.ok) {
          return;
        }
        const next = await response.json() as T;
        if (!cancelled) {
          setData(next);
        }
      } catch {
        // Keep the previous snapshot rendered.
      } finally {
        polling = false;
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [intervalMs, options.endpoint]);

  return data;
}
