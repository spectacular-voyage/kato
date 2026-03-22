import { useEffect, useState } from "preact/hooks";
import {
  listenForAuthExpiry,
  redirectToLogin,
  signalAuthExpired,
} from "./auth_expiry.ts";
import { loadPolledJson } from "../src/polled_json.ts";

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
    return listenForAuthExpiry(() => {
      redirectToLogin();
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;

    const load = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const result = await loadPolledJson<T>({
          endpoint: options.endpoint,
        });
        if (result.kind === "unauthorized") {
          signalAuthExpired();
          return;
        }
        if (result.kind === "data" && !cancelled) {
          setData(result.data);
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
