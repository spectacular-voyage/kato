import { HeaderStatusStack } from "../src/header_status.tsx";
import type { AppChromeStatus } from "../src/loaders/status.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

export default function HeaderStatusLive(
  { initialStatus }: { initialStatus: AppChromeStatus },
) {
  const status = usePolledJson({
    initialData: initialStatus,
    endpoint: "/api/chrome-status",
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });

  return <HeaderStatusStack status={status} />;
}
