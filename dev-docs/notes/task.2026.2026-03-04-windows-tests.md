---
id: 79jkdr9dfvos8y711pyaj8d
title: 2026 03 04 Windows Tests
desc: ''
updated: 1772637871719
created: 1772636147795
---

## Ideas

1. Detached daemon survives parent CLI exit on Windows
- Why: your recent notes suggest this is the main flaky area.
- Test: run `kato start`, immediately terminate the launching shell/session, then verify `status` still reports fresh heartbeat after 10-30s.

1. `start` timeout behavior when no startup ack arrives
- Gap: I don’t see coverage for `Timed out waiting for daemon startup acknowledgement`.
- Test: mock launcher returns PID but status never updates; assert command fails with that timeout error.

1. `restart` timeout behavior when stop never completes
- Gap: I don’t see coverage for `Timed out waiting for daemon to stop before restart`.
- Test: daemon remains running with fresh heartbeat forever; assert restart fails cleanly.

1. `resolveDefaultRuntimeDir` with `USERPROFILE`-only Windows env
- You test `HOME`; add explicit `HOME=undefined`, `USERPROFILE=C:\Users\...`.
- Include `KATO_RUNTIME_DIR=~\...` expansion case.

1. Launcher argument/env handling with Windows paths
- In `daemon-launcher_test.ts`, add Windows fixtures:
- `runtimeDir`, `configPath`, `statusPath`, `controlPath`, provider roots as `C:\...`
- Assert `--allow-read`/`--allow-write` include them exactly and env vars are preserved.

1. Path policy with Windows separators + traversal
- Add tests for targets like:
- `C:\allowed\sub\file.md` (allow)
- `C:\allowed\..\outside.md` (deny)
- Mixed separators like `C:\allowed/..\outside.md` (deny)

1. Workspace register path interpretation on Windows
- Test non-existent `C:\foo\bar\` treated as directory (trailing separator rule).
- Test non-existent `C:\foo\bar` treated as file candidate unless directory exists.

1. Watcher behavior for Windows-style atomic-save patterns
- Simulate create/modify/rename bursts for same file and ensure one debounced batch, not dropped events.
- This catches editor-save behavior differences common on Windows.
