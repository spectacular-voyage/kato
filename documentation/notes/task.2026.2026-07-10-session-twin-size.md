---
id: task-2026-07-10-session-twin-size
title: Session Twin Size
desc: ""
updated: 1783722000000
created: 1783722000000
---

## Goal

Show the persisted Kato twin size on each Kato Web Sessions row so operators can quickly distinguish short and long captured histories.

## Summary

Persisted session metadata already identifies the Kato twin through `twinPath`, and the Sessions loader already stats recognized persisted twins while normalizing missing twin state. That existing lookup can also project the current regular-file byte size without exposing the local twin path to the browser.

## Discussion

“Session size” can refer to a provider transcript, Kato twin, in-memory snapshot, or recording output. For this feature, the displayed value is explicitly the persisted Kato twin size: the byte length of Kato's normalized JSONL history, not the provider transcript or a recording output.

Sessions is live-polled. Size projection should reuse the twin existence stat already performed during metadata normalization and expose the value only through the Sessions page output; other surfaces that reuse `loadSessionActivityRows()` continue selecting only the fields they need.

Many discovered sessions intentionally have no persisted twin. Missing twins continue through the existing canonical reset behavior, while non-file twin paths omit the size. Existing fail-closed behavior for unexpected stat errors remains unchanged.

## Open Issues

- Should a future detail view also show message/event counts? Twin byte size is only a rough proxy for conversation length.
- Should a future detail view distinguish an unavailable/corrupt twin from an intentionally absent twin? The compact Sessions row uses one `Twin absent` state in this slice.

## Decisions

- Define the displayed value as the current persisted Kato twin file size and label it `Twin` in the row.
- Reuse metadata normalization's existing twin stat rather than adding a second stat per live poll.
- Project the optional size on the shared session-row read model; other loader consumers continue selecting only the fields they need.
- Expose `twinSizeBytes` in the web-local Sessions row model; do not expose `twinPath` and do not add a shared or persisted session contract field.
- Render `Twin absent` when no recognized regular-file twin with persisted history is present; otherwise render the formatted size, including `0 B` for a recognized zero-byte file.
- Reuse one deterministic web byte formatter for Summary memory values and Sessions twin sizes.

## Contract Changes

- `SessionActivityRow` gains optional `twinSizeBytes` in the internal Sessions/live-API page model.
- No daemon status, shared contract, or persisted metadata schema changes are required.

## Testing

- Cover byte formatting at bytes, kilobytes, and megabytes.
- Cover successful and growing twin-size projection plus missing, orphan, and non-file twin absence.
- Cover rendered Sessions row placement and copy.
- Keep existing Sessions filter/API tests green to verify size enrichment composes with live page data.

## Non-Goals

- Do not count messages, tokens, turns, events, or lines.
- Do not calculate provider transcript or recording-output sizes.
- Do not sort or filter sessions by size in this slice.
- Do not persist twin-file size.

## Implementation Plan

- [x] Add focused formatter, loader, and rendered-row tests.
- [x] Project recognized twin sizes into Sessions page data.
- [x] Render the formatted size alongside each row's updated timestamp.
- [x] Update user, developer, decision, testing, and release documentation.
- [x] Run focused validation and the full CI gate.
