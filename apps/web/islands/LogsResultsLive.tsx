import { LogResults } from "../src/log_results.tsx";
import type { LogPageData } from "../src/loaders/logs.ts";
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

  return <LogResults currentPath={props.currentPath} pageData={pageData} />;
}
