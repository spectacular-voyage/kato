---
id: fqdjyr5a0x87p49k5mynvuu
title: Deno Daemon Implementation
desc: ''
updated: 1771795692729
created: 1771724544510
---

## Purpose

Reference architecture for Kato's Deno daemon implementation.

This document is implementation-facing and should align with `dev.security-baseline.md`.

## Design Goals

1. Keep steady-state daemon permissions as narrow as practical.
2. Isolate parser failures by provider.
3. Isolate write capability by destination.
4. Keep lifecycle deterministic (`start`, `stop`, `restart`, crash recovery).
5. Keep policy decisions auditable.

## Process Topology (Reference)

```text
CLI (kato start/stop/status)
  |
  v
Launcher Process (short-lived)
  - reads policy/config
  - computes permission sets
  - starts orchestrator with constrained permissions
  - exits
  |
  v
Orchestrator Daemon (long-lived)
  - lock/pid ownership
  - worker supervision
  - state + audit writes
  |
  +--> Provider Parser Worker (claude-code)
  +--> Provider Parser Worker (codex)
  |
  +--> Destination Writer Worker (one per active destination)
```

## Process Roles

### Launcher

- Reads config/policy and validates it.
- Computes effective runtime permissions.
- Starts orchestrator with narrowed permissions.
- Exits immediately on success.

### Orchestrator daemon

- Owns `pid` and lock lifecycle.
- Supervises provider and writer workers.
- Applies command policy and destination allowlist decisions.
- Persists `state.json` and security audit log.

### Provider parser workers

- Read provider session roots.
- Parse/stream normalized messages to orchestrator.
- Must not write exports.

### Destination writer workers

- One worker per active destination file.
- Receives append/write payloads from orchestrator.
- On destination change, old writer stops and a new writer is started.

## Permission Envelope (Reference)

| Process         | Read                                                      | Write                                          | Net    | Run    | Notes                         |
| --------------- | --------------------------------------------------------- | ---------------------------------------------- | ------ | ------ | ----------------------------- |
| Launcher        | config/policy                                             | none (or startup log only)                     | denied | denied | short-lived                   |
| Orchestrator    | config/state + provider roots as needed for control paths | state/log + approved roots                     | denied | denied | no direct broad export writes |
| Provider worker | provider session roots only                               | none                                           | denied | denied | parser isolation              |
| Writer worker   | none (payload via IPC)                                    | one destination target (or minimal parent dir) | denied | denied | destination isolation         |

## Lifecycle Flows

### `kato start`

1. CLI validates command and environment.
2. Launcher loads policy/config and validates schema.
3. Launcher computes permission sets.
4. Launcher acquires bootstrap lock (or verifies daemon already running).
5. Launcher starts orchestrator.
6. Orchestrator acquires runtime lock and writes PID.
7. Orchestrator starts provider workers.
8. Launcher exits.

### `::record` / `::capture` destination change

1. Provider worker emits user message to orchestrator.
2. Orchestrator parses command and resolves canonical path.
3. Orchestrator applies allowlist/policy check.
4. If denied: emit audit event; no writer change.
5. If allowed: stop old writer for session, start new writer scoped to new destination.
6. Persist recording mapping in state.

### `kato stop`

1. CLI resolves PID/lock.
2. CLI sends termination signal to orchestrator.
3. Orchestrator drains worker shutdown sequence.
4. Orchestrator flushes state and logs.
5. Orchestrator removes PID/lock and exits.

## IPC Contract (Reference)

Use typed envelopes for all process boundaries.

```ts
type Envelope =
  | { kind: "provider.message"; provider: string; sessionId: string; offset: number; payload: NormalizedMessage }
  | { kind: "writer.append"; recordingId: string; payload: RenderChunk }
  | { kind: "policy.decision"; decision: "allow" | "deny"; reason: string; targetPath: string }
  | { kind: "worker.health"; workerType: "provider" | "writer"; status: "ok" | "error"; detail?: string };
```

Requirements:

1. Messages must be versioned for compatibility within one release line.
2. Unknown message kinds must fail closed and emit an audit event.
3. Policy denials must never be silent.

## State and Lock Model

Keep two lock artifacts:

1. PID lock: authoritative single-instance lock.
2. PID pointer: convenience for CLI/status.

State model should track:

- Session ingest cursors per provider/session (persisted in `*.meta.json`).
- SessionTwin canonical events per session (`*.twin.jsonl`).
- Recording state per session (recording id, desired state, write cursor).
- Writer worker identity/version metadata (optional but useful for debugging).

Writes must be atomic (temp + rename pattern).

Current implementation note:

- `~/.kato/daemon-control.json` is a rebuildable cache index.
- `~/.kato/sessions/*.meta.json` is authoritative session metadata.
- `~/.kato/sessions/*.twin.jsonl` is the durable canonical event log.

## Failure and Recovery Model

1. Provider worker crash:
  - Orchestrator keeps running.
  - Restart provider worker with bounded backoff.
  - Emit operational + security event.
2. Writer worker crash:
  - Pause writes for that destination.
  - Restart writer worker.
  - Mark potential write gap in audit trail.
3. Orchestrator crash:
  - PID/lock cleanup on next startup.
  - Resume from saved offsets.
4. Policy/config invalid at startup:
  - Fail startup; do not run in permissive fallback mode.

## Minimal Test Matrix

1. Start/stop/restart lock correctness.
2. Worker crash isolation and restart.
3. Destination change rotates writer worker.
4. Denied destination writes are blocked and audited.
5. Parser resume from offsets after restart.
6. No-network/no-subprocess enforcement in runtime profile.

## Notes

- Launcher-based narrowing is security-helpful but not a complete boundary; the policy source must become centrally managed/signed for stronger enterprise guarantees.
- Linux-first deployment is recommended for first hardened release due to easier service hardening and observability.
