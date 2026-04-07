---
id: b1h727ox7mfou1xlb1bb6z3
title: 2026 02 22 Claude Stenobot Codebase Analysis
desc: ''
updated: 1771786701838
created: 1771785448938
---

# User_2026-02-22_0809_02

Let's analyze the old code base under /stenobot and look for other opportunities to improve or simplify our approach. Nothing is off limits in terms of rearchitecture, given we have a new approach with other applications in the mix and other libraries to substitue.

# claude-sonnet-4.6_2026-02-22_0809_04

Let me start by reading the project guidance and then exploring the stenobot codebase.

Now let me read all the key source files in parallel.

Let me also look at the library selection note and current app stubs.

Let me read the existing kato tests and shared contracts to complete the picture.

Let me check the security baseline and the dev.deno-daemon-implementation notes.

Now I have a complete picture. Here's a comprehensive analysis:

---

## Stenobot Analysis: Opportunities for Kato

### What stenobot got right — port these intact

**Parser logic** (`providers/claude-code/parser.ts`, `providers/codex/parser.ts`) is the most mature, well-tested code. Key details to preserve exactly:
- Claude: inner `flushCurrent()` generator idiom for turn aggregation; `pendingTools` Map for tool-call/result linking; `cleanText()` regex stripping `<ide_opened_file>`, `<ide_selection>`, `<system-reminder>` blocks
- Codex: `fromOffset` state-replay-without-yielding for incremental polling; EOF flush for incomplete/legacy turns; `exec` source filter (skips sandboxed sub-agent sessions); `final_answer` phase preference over `task_complete` fallback
- Byte offset tracking: `Buffer.byteLength(line, 'utf-8') + 1` → in Deno use `new TextEncoder().encode(line).byteLength + 1`

**Provider interface** (`providers/base.ts`): `AsyncIterable<Session>` + `AsyncIterable<{message, offset}>` is clean. Keep it. The optional `resolveWorkspaceRoot?` and `getSessionLabel?` are good progressive-enhancement hooks.

**In-chat command detector** (`core/detector.ts`): Multi-format path extraction (quoted, markdown link, @-mention, `.md` bare, no-extension bare), bridge-word stripping ("to"), backtick-skip guard — all battle-tested. Keep `::record`, `::capture`, `::export`, `::stop` semantics.

**Exporter deduplication** (`core/exporter.ts:326`): The `existingTrimmed.endsWith(content)` tail-match guard before append prevents double-write on redundant polls. Worth keeping.

**Atomic state write** (`core/state.ts:42-44`): temp-file + `rename` pattern. Already aligned with kato's baseline requirement.

---

### Where stenobot's architecture breaks down — kato already solves these

**Monolithic process**: Stenobot runs parser, command detection, export, and daemon lifecycle in one Node process. Kato's planned orchestrator → provider workers → writer workers topology (per `dev.deno-daemon-implementation.md`) is strictly better:
- Provider worker crash doesn't take down the orchestrator
- Writer worker scope-locks the write destination
- Permission narrowing is only possible with process boundaries

**No path policy**: Stenobot trusted any path coming from `::capture`/`::record`. It called `expandHome` and `ensureMarkdownExtension` but no allowlist check. Kato's `policy.decision` envelope and path canonicalization requirement fix this.

**No config schema validation**: Stenobot did `yaml.parse(raw) as Partial<StenobotConfig>` — a cast, not a check. Kato's baseline requires schema validation on config load.

**Debug instrumentation via env var**: `STENOBOT_RECORDING_DEBUG === "1"` is scattered through `monitor.ts` and `exporter.ts` with verbose `logger.info` calls. Replace with proper structured log levels (`debug` opt-in).

---

### Specific improvements over stenobot

| Issue                                             | Stenobot                                                               | Kato fix                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **`decodeProjectDir`**                            | `replace(/-/g, path.sep)` — wrong for hyphenated dirs like `my-app`    | Keep the heuristic scanner from `workspace.ts` instead; document ambiguity |
| **`shortHash` / `summarizeMessages` duplication** | Copied identically in `monitor.ts:15-32` and `exporter.ts:21-39`       | Extract to `utils/debug.ts`                                                |
| **Codex readline**                                | `node:fs.createReadStream` + `node:readline`                           | `@std/streams` `TextLineStream` — cleaner async iteration                  |
| **Date formatting**                               | `date-fns-tz` `formatInTimeZone` just for one format pattern           | `Intl.DateTimeFormat` with `{ timeZone }` and `formatToParts()` — no dep   |
| **nanoid**                                        | Used only for Dendron frontmatter IDs                                  | `crypto.randomUUID().replace(/-/g,'').slice(0,10)`                         |
| **Codex model field**                             | Set from first `turn_context` only                                     | Fine for now; note it assumes one model per session                        |
| **`resolveOutputPath` @-prefix strip**            | Strips `@` from `@notes/file.md` before path resolution                | Keep exactly — VSCode injects `@` prefixes on mentions                     |
| **Code-fence blind spot**                         | `detector.ts` skips backtick spans but not ```` ``` ```` fenced blocks | Add check for commands inside fenced code blocks                           |

---

### Library substitution table

| Stenobot (npm/Node)        | Kato (Deno/JSR)                                                        | Notes                                                                  |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `chokidar`                 | `Deno.watchFs()` + debounce                                            | Native; replace `awaitWriteFinish` with a 500ms debounce utility       |
| `winston`                  | Custom JSONL logger                                                    | Already decided                                                        |
| `@stricli/core`            | `@std/cli` + in-repo router                                            | Already decided                                                        |
| `date-fns` + `date-fns-tz` | `Intl.DateTimeFormat`                                                  | `formatInTimeZone` → construct with `{ timeZone }` and `formatToParts` |
| `nanoid`                   | `crypto.randomUUID()` slice                                            | Global in Deno                                                         |
| `yaml`                     | `@std/yaml`                                                            | Direct JSR substitute                                                  |
| `chalk`                    | `@std/fmt/colors`                                                      | ANSI color utils                                                       |
| `prompts`                  | `prompt()` or thin readline wrapper                                    | Only needed for `init` interactive flow                                |
| `node:readline`            | `@std/streams` `TextLineStream`                                        | Used in Codex parser + discovery                                       |
| `node:fs/promises`         | `Deno.readTextFile`, `Deno.writeTextFile`, `Deno.mkdir`, `Deno.rename` | —                                                                      |
| `node:crypto`              | `crypto.subtle` (global)                                               | Web Crypto API                                                         |
| `node:path`                | `@std/path`                                                            | —                                                                      |
| `node:os` homedir          | `Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ""`            | No `os.homedir()` in Deno std                                          |
| `node:child_process`       | `Deno.Command`                                                         | Launcher → orchestrator spawn                                          |
| `zod`                      | Inline type guards for MVP                                             | Only appears in `package.json`, not in critical paths                  |

---

### Architecture opportunities specific to kato

**IPC distinction**: The existing `DaemonEnvelope` in `shared/src/contracts/ipc.ts` covers provider → orchestrator and orchestrator → writer. You also need a CLI ↔ orchestrator channel (for `status`, `stop`). Since the CLI is a separate invocation (not a child process), a **status file** (`~/.kato/status.json`, written atomically by the orchestrator on each state change) is the simplest MVP approach — read-only for CLI and `apps/web`. A Unix domain socket can be added later for live push.

**Gemini as a third provider**: `GEMINI.md` exists. The discovery path will differ (likely `~/.gemini/` or Google AI Studio cache), but the provider interface accommodates it unchanged. Design the provider registry to load providers dynamically from config so adding Gemini doesn't require touching the orchestrator.

**`apps/web` live status**: With a status file approach, `apps/web` just reads and renders `~/.kato/status.json` (perhaps on a poll or `Deno.watchFs` on that one file). Very cheap and no IPC complexity needed for MVP.

**Writer worker rotation on `::record`**: Stenobot stopped the old recording and started a new one in-line in `handleCommand`. In kato, the orchestrator sends `writer.append` envelopes; on a `::record` command it stops the old writer worker and starts a new one scoped to the new destination. The `PolicyDecisionEnvelope` fires before the new writer starts.

**What to do with `config.ts` `deepMerge`**: It's hand-rolled but correct. In Deno, keep it — or use `structuredClone` + spread for shallower configs. The deep-merge is only needed because provider config is nested. Worth keeping as a small utility.

---

### Migration sequencing suggestion

Given what tests already exist in kato (`claude-parser_test.ts` imports `apps/daemon/src/providers/claude/mod.ts` which doesn't exist yet), the natural order is:

1. **Port parsers first** — tests are already written; just need the implementations under `apps/daemon/src/providers/`
2. **Port command detector** — pure logic, no external deps
3. **Port exporter** — markdown generation, replace `date-fns-tz` and `nanoid`
4. **Port state manager** — trivial Deno translation
5. **Build orchestrator monitor loop** — replaces `SessionMonitor`, but now posts to workers via IPC rather than calling export directly
6. **Build CLI** — `@std/cli` + in-repo router for `start/stop/status/clean/export`
7. **Implement path policy layer** — the one thing stenobot was entirely missing

The parsers are the highest-value, lowest-risk work to do first.

# User_2026-02-22_1037_40

::capture @dev-docs/notes/conv.2026.2026-02-22_claude_stenobot-codebase-analysis.md

# claude-sonnet-4.6_2026-02-22_1037_55

Per `dev.general-guidance.md`, ignoring that control command — stenobot handles it.
