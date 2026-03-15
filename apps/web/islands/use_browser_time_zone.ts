import { useEffect, useState } from "preact/hooks";

export function useBrowserTimeZone(): string | undefined {
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      const next = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (next) {
        setTimeZone(next);
      }
    } catch {
      // Keep the stable UTC/ISO fallback if the browser cannot resolve a zone.
    }
  }, []);

  return timeZone;
}
