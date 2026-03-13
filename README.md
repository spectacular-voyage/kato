# Kato

## Own your AI conversations.

Kato captures AI conversations from supported IDEs and CLIs into files you
control. It records to Markdown or JSONL, runs a local daemon, can serve a
local web console, and ships as prebuilt binaries for normal use.

## Supported Today

- `Codex`: VS Code, CLI, local app
- `Claude Code`: VS Code, CLI, local app
- `Gemini`: VS Code, CLI

## Install

Primary install:

```bash
npm install -g @spectacular-voyage/kato
kato --version
```

The npm package installs prebuilt binaries. It does not compile Kato on your
machine.

One-off use:

```bash
npx @spectacular-voyage/kato@latest --version
```

You can also download a prebuilt bundle from
[GitHub Releases](https://github.com/spectacular-voyage/kato/releases) and put
the extracted bundle directory on your `PATH`.

Supported install targets: Windows x64, macOS x64, macOS arm64, Linux x64
glibc.

The public command is `kato`. Bundled `kato-daemon` and `kato-web` are managed
for you.

## Quickstart

```bash
kato init
kato start

mkdir chats-default
cd chats-default
kato workspace init
kato workspace register --alias default
```

Then start a new supported AI chat and put `::capture-default` on its own line
in a user message. It also helps to tell the model to ignore lines that start
with `::`.

## In-Chat Commands

- `::capture-<alias> [path]`: snapshot the full conversation, then keep
  recording there
- `::record-<alias> [path]`: start recording from this point forward
- `::export-<alias> [path]`: write a one-off export
- `::stop`: stop all active recordings
- `::stop-<alias>`: stop one workspace output

## Local Web

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
project notes live in `dev-docs/notes`.
