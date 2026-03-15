import { LogResults } from "../src/log_results.tsx";
import type { LogPageData } from "../src/loaders/logs.ts";
import { useBrowserTimeZone } from "./use_browser_time_zone.ts";
import { LIVE_POLL_INTERVAL_MS, usePolledJson } from "./use_polled_json.ts";

export default function LogsResultsLive(
  props: {
    currentPath: string;
    endpoint: string;
    initialData: LogPageData;
  },
) {
  const pageData = usePolledJson({
    initialData: props.initialData,
    endpoint: props.endpoint,
    intervalMs: LIVE_POLL_INTERVAL_MS,
  });
  const timeZone = useBrowserTimeZone();

  return (
    <LogResults
      currentPath={props.currentPath}
      pageData={pageData}
      timeZone={timeZone}
    />
  );
}
