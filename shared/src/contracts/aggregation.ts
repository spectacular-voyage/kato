import type { DaemonStatusSnapshot } from "./status.ts";

export interface StatusAggregationRecord {
  sourceNodeId: string;
  receivedAt: string;
  snapshot: DaemonStatusSnapshot;
}
