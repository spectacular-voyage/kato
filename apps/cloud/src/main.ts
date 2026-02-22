import type {
  DaemonStatusSnapshot,
  StatusAggregationRecord,
} from "@kato/shared";

export function toStatusAggregationRecord(
  sourceNodeId: string,
  snapshot: DaemonStatusSnapshot,
): StatusAggregationRecord {
  return {
    sourceNodeId,
    receivedAt: new Date().toISOString(),
    snapshot,
  };
}
