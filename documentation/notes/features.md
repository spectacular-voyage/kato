---
id: 072ugh6pvxoycs3gqy31fhz
title: Features
desc: ''
updated: 1774326458974
created: 1774326332892
---

# Own your AI conversations

Kato captures supported local AI conversations into files you control. It runs
as a local daemon, with CLI and web surfaces for setup, status, capture,
recording, export, cleanup, and workspace management.

Use this note for shipped behavior. Future-facing work lives in [[roadmap]] and
idea-bank material lives in [[product-ideas]].

## Supported Conversation Sources

Kato reads local provider transcript/session files and normalizes them into a
provider-agnostic event stream.

Current compatibility is tracked in [[compatibility]]:

- `Codex`: VS Code, CLI, local app
- `Claude Code`: VS Code, CLI, local app
- `Gemini`: VS Code, CLI

Kato does not replace those tools. It observes their local session artifacts,
builds Kato-owned twins, and writes user-selected outputs into registered
workspaces.

## Local Daemon Runtime

The daemon is the capture and recording engine. The `kato` CLI initializes
configuration, starts and stops the daemon, queues control requests, and reads
status. Kato Web provides a browser-based operator console over the same local
runtime.

Useful lifecycle commands:

```bash
kato init
kato start
kato status
kato status --live
kato restart
kato stop
```

The CLI is useful on its own for setup, status, export requests, cleanup, and
workspace management, but ongoing capture/recording behavior depends on the
daemon runtime.

## Workspaces

Workspaces are the destinations Kato is allowed to write into. A workspace has
a local `.kato-workspace-config.yaml` file, a registered alias, and an entry in
the shared workspace registry.

Workspace features include:

- workspace-local output defaults;
- output filename templates;
- workspace timezone settings;
- shared default tags and tag suggestions;
- markdown frontmatter settings;
- writer feature flags for commentary, thinking, tool calls/results, decision
  prompts/options/selections, user-message italics, relative link sanitization,
  and Dendron wikilink rendering;
- optional operator-facing display labels;
- per-workspace preferred participant usernames.

The daemon write policy is scoped to registered workspace roots. When
registration expands `allowedWriteRoots`, `kato workspace register` restarts
the daemon by default so the running process picks up the new write boundary.

## Capture, Recording, And Export

Kato supports three related output workflows:

- **Capture** writes a snapshot of the conversation and then keeps recording.
- **Record** starts a new output from the command point forward.
- **Export** queues a one-off export of a known session.

In-chat control commands:

```text
::capture-<alias> [path]
::record-<alias> [path]
::export-<alias> [path]
::stop
::stop-<alias>
```

Web-created captures and recordings are available from the Sessions page. The creation popover can set an output title, filename snippet, and per-output tags before the file is created. Active and stopped recording outputs can be managed from Sessions and Recordings, and output tags can be edited from Recordings after creation.

Markdown is the normal recording format. One-off exports can also use JSONL.

## Session Twins

Kato persists provider-session metadata and canonical twin files under
`~/.kato/shared/sessions/`. Twins give Kato a durable replay source for status,
snippets, troubleshooting, and future output operations without depending only
on the daemon's live memory.

The Maintenance page exposes twin troubleshooting and cleanup workflows.

The Sessions inventory shows a path-free `Twin <size>` cue for recognized persisted history and `Twin absent` otherwise. The 1024-based byte count is a rough persisted-history measure and can be partial when twin persistence began after the provider conversation started; Maintenance remains the owner of twin paths, state, troubleshooting, and cleanup.

## Session Inventory Trees

The Sessions inventory always groups provider-declared Claude and Codex sub-conversations beneath their parents in recursive trees that default closed. Parent disclosures summarize descendant activity and child Twin bytes; expanded children retain their own rows, actions, recordings, and Twin sizes. Relationships come only from provider contracts, never repeated titles or timing guesses; legacy `subagents` query parameters are ignored.

## Kato Web

Kato Web is a local authenticated operator console. Current pages include:

- Summary dashboard;
- Sessions inventory with default-closed parent/sub-conversation trees, activity/workspace filtering, capture/record controls, creation-time metadata fields, snippet reveal, and read-only per-row/child-summary persisted-twin size cues;
- Recordings status, output tag editing, stop controls, and re-arm controls;
- Workspaces registration, labels, username overrides, shared tag/default config editing, and diagnostics;
- Logs for operational and security-audit records;
- Settings for user-default, workspace username mapping, and personal tag suggestion workflows;
- Maintenance for logs and old derived session artifacts.

Kato Web uses the configured host/port as a preference. If the preferred port
is busy, startup scans upward and writes the actual running URL into web
status.

## Security And Redaction

Kato is local-first: no cloud service or network access is required for the
baseline capture/export workflow.

The runtime is designed around explicit filesystem scope:

- provider session roots define what source transcripts Kato may read;
- registered workspace roots define where Kato may write;
- logs and session state stay under the Kato runtime directory.

Secrets redaction is enabled by default. Captured conversations are scanned
for common credential patterns before Kato writes twins, recordings, exports,
or web snippets. Matches are replaced with `[REDACTED:<rule-id>]`, and audit
logs record rule/count metadata without storing the secret.

The provider tool's original transcript file is outside Kato's control and may
still contain the original text.

## Markdown Output

Markdown recordings can include frontmatter, output tags, participant metadata, Kato ids, conversation event kinds, commentary, thinking, tool calls/results, and decision metadata according to shared and workspace-level writer settings.

Workspace markdown output sanitizes absolute local markdown links/images to
relative paths by default. Workspaces can also opt into Dendron-style
wikilinks for local note links; Kato discovers `dendron.yml` context and only
rewrites eligible note targets.

## Distribution

The primary install path is the npm package:

```bash
npm install -g @spectacular-voyage/kato@latest
```

The package installs prebuilt binaries; it does not compile Kato locally.
GitHub Release bundles are also available for supported platforms.
