---
id: 7ecj3k8amurczz02kra9ucm
title: 2026 03 22 Liveness
desc: ''
updated: 1774189402414
created: 1774188207607
---

## Goal

- redirect all open authenticated browser tabs to `/login` when the web session expires
- report daemon and web liveness without claiming a stale service is still `running`


## Summary

- if the web auth cookie expires, authenticated browser tabs should converge on `/login` instead of leaving stale live views rendered indefinitely
- stale daemon heartbeat remains distinct from `stopped`; operator-facing daemon surfaces should present that state as `unresponsive`
- web service liveness should prefer the PID/process probe when available; a definitively dead process should be reported as `stopped`
- this task changes derived presentation and browser/session handling; it should not require a status-file schema change

## Discussion

- `stopped` should remain authoritative. It means we know the service is not running because it shut down cleanly or an operator explicitly reset stale state to stopped.
- `unresponsive` should mean ambiguity or inconclusive liveness, not merely "the last persisted file said running."
- for the daemon, this task should keep the existing heartbeat-based stale detection and only change the derived CLI/web wording. The existing stale threshold remains `DEFAULT_STALE_HEARTBEAT_THRESHOLD_MS` (`11_000`) in `apps/runtime/src/orchestrator/control_plane.ts`. Adding a daemon PID/process probe is a follow-up if heartbeat ambiguity keeps causing operator pain.
- for the web service, keep using the existing process probe as the authoritative live check when it returns a definitive answer. If the probe says the PID is gone, report `stopped`, even if the last persisted status still says `running=true`. Reserve `unresponsive` for future or exceptional cases where live checks are unavailable or inconclusive.
- live browser islands currently ignore non-OK poll responses, so auth expiry can leave old data on screen. This task should route `401` handling through shared client-side polling/auth code and fan that expiry out to sibling tabs.

| Scenario | Persistent Covered | Non-Persistent Covered | Expected Same? | Intentional Divergence Notes |
| --- | --- | --- | --- | --- |
| Daemon snapshot says `daemonRunning=false` | Yes | No | Yes | Remains `stopped` |
| Daemon snapshot says `daemonRunning=true` with fresh heartbeat | Yes | No | Yes | Remains `running` |
| Daemon snapshot says `daemonRunning=true` with stale heartbeat | Yes | No | No | Present as `unresponsive`; do not collapse to `stopped` |
| Web status says `running=true` and PID probe passes | Yes | Yes | Yes | Remains `running` |
| Web status says `running=true` but PID probe definitively reports the process absent/dead | Yes | Yes | No | Present as `stopped`; may retain last heartbeat/PID as diagnostic detail only |
| Web status cannot be confirmed because the current live check is unavailable or inconclusive | Yes | Yes | No | Reserve `unresponsive` for this ambiguity class, not the common dead-process case |
| Browser session expires while one or more tabs are open | Cookie/session state only | Yes | No | First `401` should trigger a shared logout/redirect signal so all open authenticated tabs navigate to `/login` |

Legend: `Persistent Covered` means state written to disk (`status.json` / `kato-web-status.json`). `Non-Persistent Covered` means live process/browser evidence such as heartbeat freshness, PID probes, or in-tab auth detection.

## Open Issues

- none at the task-note level; if implementation reveals browser compatibility issues, record them in `## Decisions` or a follow-up task note

## Decisions

- do not map stale daemon heartbeat directly to `stopped`
- use `unresponsive` as the operator-facing term for stale daemon liveness and other genuinely ambiguous/inconclusive liveness states
- for `kato web status`, a definitive negative PID/process probe maps to `stopped`, not `unresponsive`
- keep `running` reserved for fresh/current liveness signals
- keep `stopped` reserved for authoritative non-running state
- do not change persisted daemon/web status schema in this task; persisted `running` remains an internal lifecycle/diagnostic input, and derived operator-facing state may disagree with it
- implement session-expiry handling through shared client-side auth failure detection plus cross-tab propagation rather than per-page ad hoc redirects
- update the web header/chrome wording from `unknown` to `unresponsive` in this task so CLI and web use the same operator-facing language
- use the existing shared header polling path as the lightweight global auth-expiry probe on authenticated pages
- use `BroadcastChannel` as the primary cross-tab auth-expiry signal and a `localStorage` / `storage` event fallback for sibling-tab convergence
- remove the separate `HEARTBEAT` label from the compact web header once heartbeat freshness is folded into daemon state; keep detailed heartbeat timing available on full status/detail surfaces

## Contract Changes

- daemon status presentation contract:
  - `running`: `daemonRunning=true` and heartbeat current
  - `unresponsive`: `daemonRunning=true` and heartbeat stale under the existing `DEFAULT_STALE_HEARTBEAT_THRESHOLD_MS` (`11_000`) threshold
  - `stopped`: `daemonRunning=false`
- web status presentation contract:
  - `running`: current PID/process probe confirms the persisted web PID is alive
  - `stopped`: persisted `running=false`, or persisted `running=true` but the current PID/process probe definitively reports the process absent/dead
  - `unresponsive`: reserved for cases where the web service cannot be confidently classified as `running` or `stopped` because current live checks are unavailable or inconclusive
- browser auth contract:
  - authenticated live requests that receive `401` are terminal for the current browser session
  - the first tab that detects auth expiry should trigger a shared client-side logout/redirect signal
  - cross-tab propagation should use `BroadcastChannel` first and fall back to `localStorage` / `storage` events
  - all open authenticated tabs should navigate to `/login` after that signal
- no JSON schema change is expected for `status.json` or `kato-web-status.json`

## Testing

- add CLI status coverage for daemon `running` vs `unresponsive` vs `stopped` rendering
- add CLI web-status coverage for `running` vs `stopped` when the process probe disagrees with persisted status, and for `unresponsive` if an inconclusive-probe path is introduced
- add web chrome/header coverage for `running` vs `unresponsive` vs `stopped` wording
- add web header coverage confirming the compact header no longer renders a separate `HEARTBEAT` row
- add shared client polling/auth tests so `401` stops normal live updates and triggers the auth-expired flow once
- add browser/island tests for cross-tab auth-expiry propagation and redirect to `/login`, including simultaneous `401` detection in multiple tabs and idempotent redirect/broadcast handling
- regression-check that existing authenticated API routes still return `401` for unauthenticated `/api/*` requests and `302` redirects for page requests
- before merge, run the relevant targeted suites plus `deno task fmt` and `deno task ci`

## Non-Goals

- adding daemon PID/process probing
- redesigning the persisted daemon/web status file schema
- changing session TTL or the cookie-signing format
- adding server-push/WebSocket auth invalidation

## Implementation Plan

- [x] document the derived liveness contract in this task note before broad implementation
- [x] update daemon CLI status rendering so stale heartbeat is shown as `unresponsive` rather than `running`
- [x] update web CLI status rendering so a definitively dead probed web process is shown as `stopped` rather than `running` or `stale status`
- [x] update the web compact header so stale daemon/web chrome is shown as `unresponsive` and the separate `HEARTBEAT` row is removed
- [x] introduce shared client-side auth-expiry handling in the existing header/live polling path so `401` responses trigger a logout/redirect flow
- [x] add cross-tab propagation via `BroadcastChannel` with `localStorage` fallback so one tab detecting expiry redirects sibling authenticated tabs to `/login`
- [x] add targeted tests for daemon/web liveness wording and browser auth-expiry behavior
