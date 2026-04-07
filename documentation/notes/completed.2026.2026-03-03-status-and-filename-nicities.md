---
id: w6b94oems6fe8zvxgvlssfr
title: 2026 03 03 Status and Filename Nicities
desc: ''
updated: 1772481151678
created: 1772477575132
---


## Filename template

- support the {recordingId} in filename template, to let users guarantee a unique output file
 

## Status improvements

### Surfacing Errors

WARN, ERROR level operational and audit log errors, including anything related to failed permissions, failed recording start, etc. should be surfaced in the status output in a new "Recent Errors" section


## improved recording status

Currently, recording has:

```
● claude: "The Session status for this conversation is:" (5e9c4b04)  ·  updated 2026-03-02 10:47  ·  last event 1m ago
  ● recording (db01a3b2) -> /home/djradon/hub/spectacular-voyage/kato/documentation/notes/conv.2026.2026-03-02_1047-the-session-status-for-this-conversation-is-claude.md
     started 1m ago · last write 29m ago · workspace: k
```

let's switch the path to the bottom and the other info to the top:

```
● claude: "The Session status for this conversation is:" (5e9c4b04)  ·  updated 2026-03-02 10:47  ·  last event 1m ago
  ● recording (db01a3b2) started: 2026-03-02 10:47 · last written 29m ago · workspace: k
   -> /home/djradon/hub/spectacular-voyage/kato/documentation/notes/conv.2026.2026-03-02_1047-the-session-status-for-this-conversation-is-claude.md
```

Also, how can "started" be more current that "last write"? I would say only in the case that a recording is restarted from the CLI, and there haven't been any new writes yet? But even then, when you "re-start" a recording, it's actually a new recording using the old output target, so started should always be older than last write.


## Implementation Update (2026-03-03)

- [x] Add `{recordingId}` filename-template token support (deferred).
- [x] Add `Recent Errors` status section sourced from operational + security-audit WARN/ERROR logs.
- [x] Change recording status layout to details first and destination path on the next line.
- [x] Render recording detail as `started: <timestamp>` and include `re-started <relative>` when cycles indicate a restart.
- [x] Promote provider permission-denied ingestion events (`provider.ingestion.read_denied`) to operational `ERROR`.
- [x] Promote invalid workspace rows into `Recent Errors` as operational `ERROR` entries.
- [x] Emit best-effort startup operational log entries for runtime-config load/validation failures with `severity: critical`.
