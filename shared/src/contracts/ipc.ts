export type ProviderCursor =
  | { kind: "byte-offset"; value: number }
  | { kind: "item-index"; value: number }
  | { kind: "opaque"; value: string };

export type ProviderMessageEnvelope = {
  kind: "provider.message";
  provider: string;
  sessionId: string;
  cursor: ProviderCursor;
  payload: unknown;
};

export type WriterAppendEnvelope = {
  kind: "writer.append";
  recordingId: string;
  payload: unknown;
};

export type PolicyDecisionEnvelope = {
  kind: "policy.decision";
  decision: "allow" | "deny";
  reason: string;
  targetPath: string;
};

export type WorkerHealthEnvelope = {
  kind: "worker.health";
  workerType: "provider" | "writer";
  status: "ok" | "error";
  detail?: string;
};

export type DaemonEnvelope =
  | ProviderMessageEnvelope
  | WriterAppendEnvelope
  | PolicyDecisionEnvelope
  | WorkerHealthEnvelope;
