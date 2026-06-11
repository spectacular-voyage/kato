# Kato

## Own your AI conversations.

Kato captures AI conversations from supported IDEs, CLIs, and local apps into files you control. A local daemon creates vendor-agnostic chat "twins" and monitors chats for kato commands like "record" or "stop". It can serve a local web console, and also has a terminal-based status console.

## Compatibility

- `Codex`: VS Code, CLI, local app
- `Claude Code`: VS Code, CLI, local app
- `Gemini`: VS Code, CLI

## Install

Primary install:

```bash
npm install -g @spectacular-voyage/kato@latest
```

Or with pnpm:

```bash
pnpm add -g @spectacular-voyage/kato@latest
```

The npm package installs prebuilt binaries. It does not compile Kato on your
machine.

You can also download a prebuilt bundle from
[GitHub Releases](https://github.com/spectacular-voyage/kato/releases) and put
the extracted bundle directory on your `PATH`.

Supported install targets: Windows x64, macOS x64, macOS arm64, Linux x64
glibc.

The public command is `kato`. Bundled `kato-daemon` and `kato-web` are managed
for you.

## Upgrade

With npm:

```bash
npm install -g @spectacular-voyage/kato@latest
```

With pnpm:

```bash
pnpm update -g @spectacular-voyage/kato --latest
```

Then confirm the active `kato` on your `PATH`:

```bash
kato --version
```

## Quickstart

```bash
kato init
kato start

mkdir chats-default
cd chats-default
kato workspace init
kato workspace register --alias default --name 'My first Kato workspace'
```

Then start a new supported AI chat and put `::capture-default` on its own line
in a user message. It also helps to tell the model to ignore lines that start
with `::`.

You can also trigger recording from the "Sessions" page in the web UI.

## In-Chat Commands

- `::capture-<alias> [path]`: snapshot the full conversation, then keep
  recording
- `::record-<alias> [path]`: start recording from this point forward
- `::export-<alias> [path]`: write a one-off export
- `::stop`: stop all active recordings
- `::stop-<alias>`: stop one workspace output

## Secrets Redaction

By default, Kato scans every captured conversation for things that look like
credentials — vendor API keys (AWS, GitHub, Slack, OpenAI, Anthropic, …), PEM
private keys, JWTs, and `password=`/`api_key=`-style assignments — and
replaces them with `[REDACTED:<rule-id>]` placeholders before anything is
written to twins, recordings, exports, or shown in the web UI. Each redaction
is recorded in the security audit log (rule and count only, never the secret).

Note: the AI tool's own transcript files still contain the original text;
Kato only controls what lands in Kato-created files.

Configure via `secretsPolicy` in `~/.kato/shared/kato-shared-config.yaml`:

```yaml
secretsPolicy:
  mode: redact            # redact (default) | detect (log only) | off
  disabledRules: []       # rule ids to skip, e.g. [jwt]
  allowlist: []           # literal substrings or /regex/ to never redact
```

## Local Web

From the web UI, you can start and stop recordings, and manage your Kato data and configuration. 

```bash
kato web init --username <username>
kato web start
```

Then open `http://127.0.0.1:5173/login`.

`kato web init` prompts for a password on an interactive terminal. If config
already exists, Kato reuses it.

## Help

Use `kato help`, `kato help web`, and `kato help workspace` for current command
details.

## Development

Deno 2.x is only required if you are developing Kato from source. Internal
project notes live in `documentation/notes`.
