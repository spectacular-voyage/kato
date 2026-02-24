---
id: rqrupsu8yrshs2femj55rch
title: Feature Ideas
desc: ''
updated: 1771869706161
created: 1771724652182
---

- each project/workspace folder can have its own .kato file/folder that specified where conversations go by default and filename patterns
  - extremely useful if all conversations go to the same place and should follow the same pattern
- scan recent folders more recently, scan older folders (much) less frequency
- add scanning for .codex/.claude folders even if not initially present
- support restart and reload CLI commands
- handle recording of "choices" options and chosen option
- support for gemini, kimi, etc
- add an "interlocutors" YAML field, and maybe a sessionId filed as well. 
- create a summary file (and/or decision log, maybe update a to-do file) on command
- overhaul status
- switch to deno and multi-agent structure with each agent monitoring a single source, and outputing to only allowed destinations
- "::seal" command : sign, hash, and close a file
- web-based UI for status; cleaning sessions, surfacing history and logs
- run-as-service on windows; systemd/init.d on linux; and whatever macos uses
- thinking and tools use should use, as default, the settings in config but allow per-session overrids, maybe by adding flags to the "::" commands
- switch config to YAML