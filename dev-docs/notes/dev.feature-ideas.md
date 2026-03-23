---
id: rqrupsu8yrshs2femj55rch
title: Feature Ideas
desc: ""
updated: 1774242249060
created: 1771724652182
---

- Workspace detail page that included config options, and the ability to change them.
- separate markdownFilenameTemplate and jsonlFilenameTemplate
  - jsonl should support a metadata section
- thinking and tools use should use, as default, the settings in config (defaults/general/workspace) but allow per-session overides, maybe by adding flags to the '::' commands
- scan recent folders more recently, scan older folders (much) less frequency
- add scanning for .codex/.claude folders even if not initially present
- support for kimi, copilot, roo, cline, opencode, etc.
- multiple recordings to one file
- create a summary file (and/or decision log, maybe update a to-do file) on
  command
  - dangerous because AI/network
- "::seal" command : sign, hash, and close a file
  - tricky, because we can't write the hash into the file?
- web-based UI for status; surfacing history and logs; surfacing in-chat
  commands; tracking performance
- run-as-service on Windows; systemd/init.d on Linux; launchd on macOS
- support flag in in-chat comments, e.g. to start including thinking or tool use
- folder-based session-state and twin files (maybe just by year? or probably
  year-month)
- instead of "User_unknown-time" headings, we could number sequentially, or use
  the event IDs
- define alias errors for recording/export explicitly: default is user-facing
  CLI/daemon status error messaging; "silent failure" means suppressing
  user-facing output while allowing only non-critical logs; add an explicit
  toggle (CLI flag or config key) to enable silent failure behavior for
  unexpected aliases
- real (OS-aware) liveness check
- workspace alias mapping stored in config


## Interoperability

- https://github.com/strongdm/cxdb format export
